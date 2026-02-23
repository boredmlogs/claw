import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, DATA_DIR, SLACK_APP_TOKEN, SLACK_BOT_TOKEN } from '../config.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcribe.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const AUDIO_EXTENSIONS = new Set(['.ogg', '.oga', '.mp3', '.m4a', '.wav', '.webm', '.mp4']);

/**
 * Convert common Markdown formatting to Slack mrkdwn.
 * The agent is instructed to use mrkdwn, but Claude sometimes slips
 * back to Markdown habits. This catches the most common mismatches.
 */
function markdownToMrkdwn(text: string): string {
  // Preserve code blocks and inline code from modification
  const preserved: string[] = [];
  let result = text.replace(/```[\s\S]*?```|`[^`]+`/g, (match) => {
    preserved.push(match);
    return `\x00P${preserved.length - 1}\x00`;
  });

  // **bold** → *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // ## Heading → *Heading*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Restore preserved spans
  result = result.replace(/\x00P(\d+)\x00/g, (_, i) => preserved[parseInt(i)]);

  return result;
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private connected = false;
  private botUserId = '';
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  // Tracks @mention ts values awaiting their first ✅ reaction
  private mentionAnchors: Set<string> = new Set();
  // Maps any messageTs → threadTs for messages seen in threads
  private messageThreadMap: Map<string, string> = new Map();
  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.app = new App({
      token: SLACK_BOT_TOKEN,
      appToken: SLACK_APP_TOKEN,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }

  async connect(): Promise<void> {
    // Resolve bot user ID
    const authResult = await this.app.client.auth.test({ token: SLACK_BOT_TOKEN });
    this.botUserId = authResult.user_id || '';
    logger.info({ botUserId: this.botUserId }, 'Slack bot user resolved');

    // Register message handler
    this.app.event('message', async ({ event }) => {
      await this.handleMessage(event as unknown as Record<string, unknown>);
    });

    // Register reaction handler — delivers reactions as messages to the agent
    this.app.event('reaction_added', async ({ event }) => {
      if (event.user === this.botUserId) return;

      const channel = event.item.channel;
      const itemTs = event.item.ts;
      const channelJid = `slack:${channel}`;

      // Determine JID: look up which thread this message belongs to
      const threadTs = this.messageThreadMap.get(itemTs);
      const jid = threadTs ? `slack:${channel}:${threadTs}` : channelJid;

      const timestamp = new Date(parseFloat(event.event_ts) * 1000).toISOString();

      // Store chat metadata
      this.opts.onChatMetadata(channelJid, timestamp, undefined, 'slack', true);
      if (jid !== channelJid) {
        this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', true);
      }

      // Only deliver for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[channelJid]) return;

      const msg: NewMessage = {
        id: `reaction-${event.event_ts}`,
        chat_jid: jid,
        sender: event.user,
        sender_name: event.user,
        content: `<reaction emoji="${event.reaction}" on_ts="${itemTs}" />`,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.opts.onMessage(jid, msg);
    });

    await this.app.start();
    this.connected = true;
    logger.info('Slack connected via Socket Mode');

    // Flush queued messages
    await this.flushOutgoingQueue();
  }

  private async handleMessage(event: Record<string, unknown>): Promise<void> {
    logger.debug({ event: JSON.stringify(event).slice(0, 500) }, 'Slack message event received');

    // Skip bot messages and message_changed subtypes
    if (event.bot_id || event.bot_profile || event.app_id || event.user === this.botUserId) return;
    if (event.subtype && event.subtype !== 'file_share') return;

    const channel = event.channel as string;
    const threadTs = event.thread_ts as string | undefined;
    const messageTs = event.ts as string;
    const user = event.user as string;
    let text = (event.text as string) || '';
    const files = event.files as Array<Record<string, unknown>> | undefined;

    // Determine JID
    let jid: string;
    if (threadTs) {
      jid = `slack:${channel}:${threadTs}`;
      // Track this message's thread membership for reaction routing
      this.messageThreadMap.set(messageTs, threadTs);
    } else {
      // Top-level channel message
      jid = `slack:${channel}`;
    }
    const channelJid = `slack:${channel}`;

    // Replace bot mention with @AssistantName
    const mentionPattern = new RegExp(`<@${this.botUserId}>`, 'g');
    const hasMention = mentionPattern.test(text);
    text = text.replace(mentionPattern, `@${ASSISTANT_NAME}`);

    // Handle files
    const fileTags: string[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        const savedPath = await this.downloadFile(file, channelJid);
        if (savedPath) {
          const fileName = file.name as string || 'unknown';
          const ext = path.extname(fileName).toLowerCase();

          if (AUDIO_EXTENSIONS.has(ext)) {
            // Transcribe audio
            const transcript = await transcribeAudio(savedPath);
            if (transcript) {
              fileTags.push(`<file name="${fileName}" path="${savedPath}">\n<transcript>${transcript}</transcript>\n</file>`);
            } else {
              fileTags.push(`<file name="${fileName}" path="${savedPath}" />`);
            }
          } else {
            fileTags.push(`<file name="${fileName}" path="${savedPath}" />`);
          }
        }
      }
    }

    // Append file tags to text
    if (fileTags.length > 0) {
      text = text ? `${text}\n${fileTags.join('\n')}` : fileTags.join('\n');
    }

    if (!text) return;

    const timestamp = new Date(parseFloat(messageTs) * 1000).toISOString();

    // Store chat metadata for channel (and thread JID if different)
    this.opts.onChatMetadata(channelJid, timestamp, undefined, 'slack', true);
    if (jid !== channelJid) {
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', true);
    }

    // Check if this is for a registered group
    const groups = this.opts.registeredGroups();
    const isRegistered = groups[channelJid] || Object.keys(groups).some(
      (gJid) => jid.startsWith(gJid + ':'),
    );
    if (!isRegistered) return;

    // React 👀 on @mention messages (top-level only) and route to a thread JID
    if (hasMention && !threadTs) {
      this.addReaction(channel, messageTs, 'eyes').catch((err) =>
        logger.warn({ err }, 'Failed to add 👀 reaction'),
      );
      // Assign a thread JID so all agent responses post as thread replies
      jid = `slack:${channel}:${messageTs}`;
      this.mentionAnchors.add(messageTs);
      this.messageThreadMap.set(messageTs, messageTs);
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', true);
    }

    // Build message
    const msg: NewMessage = {
      id: messageTs,
      chat_jid: jid,
      sender: user,
      sender_name: user, // Slack user ID; could resolve display name but not critical
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    this.opts.onMessage(jid, msg);
  }

  private async downloadFile(
    file: Record<string, unknown>,
    channelJid: string,
  ): Promise<string | null> {
    const url = file.url_private_download as string;
    if (!url) return null;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });
      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'Failed to download Slack file');
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const fileId = file.id as string || Date.now().toString();
      const fileName = file.name as string || 'file';
      const safeName = `${fileId}-${fileName}`;

      // Resolve group folder from channel JID
      const groups = this.opts.registeredGroups();
      const group = groups[channelJid];
      if (!group) return null;

      const filesDir = path.join(resolveGroupIpcPath(group.folder), 'files');
      fs.mkdirSync(filesDir, { recursive: true });
      const filePath = path.join(filesDir, safeName);
      fs.writeFileSync(filePath, buffer);

      logger.info({ fileId, fileName, filePath }, 'Slack file downloaded');
      return `/workspace/ipc/files/${safeName}`;
    } catch (err) {
      logger.error({ err }, 'Error downloading Slack file');
      return null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, queueSize: this.outgoingQueue.length }, 'Slack disconnected, message queued');
      return;
    }

    try {
      const parsed = this.parseJid(jid);
      if (!parsed) return;

      const formatted = markdownToMrkdwn(text);

      if (parsed.threadTs) {
        // Post to thread (both existing threads and mention-created threads)
        const result = await this.app.client.chat.postMessage({
          token: SLACK_BOT_TOKEN,
          channel: parsed.channel,
          thread_ts: parsed.threadTs,
          text: formatted,
        });
        // Track bot message for reaction routing
        if (result.ts) {
          this.messageThreadMap.set(result.ts, parsed.threadTs);
        }
        // First response to an @mention thread gets ✅
        if (this.mentionAnchors.delete(parsed.threadTs)) {
          this.addReaction(parsed.channel, parsed.threadTs, 'white_check_mark').catch((err) =>
            logger.warn({ err }, 'Failed to add ✅ reaction'),
          );
        }
      } else {
        // Post to main channel
        await this.app.client.chat.postMessage({
          token: SLACK_BOT_TOKEN,
          channel: parsed.channel,
          text: formatted,
        });
      }

      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send Slack message, queued');
    }
  }

  async sendFile(jid: string, filePath: string, title?: string): Promise<void> {
    const parsed = this.parseJid(jid);
    if (!parsed) return;

    try {
      // Resolve host path from container path
      const groups = this.opts.registeredGroups();
      const channelJid = `slack:${parsed.channel}`;
      const group = groups[channelJid];
      let hostPath = filePath;

      if (filePath.startsWith('/workspace/ipc/')) {
        // Absolute container path → resolve to host IPC directory
        const relativePath = filePath.slice('/workspace/ipc/'.length);
        if (group) {
          hostPath = path.join(resolveGroupIpcPath(group.folder), relativePath);
        }
      } else if (!path.isAbsolute(filePath) && group) {
        // Relative path (bare filename or relative) → resolve under IPC files dir
        hostPath = path.join(resolveGroupIpcPath(group.folder), 'files', filePath);
      }

      const fileContent = fs.readFileSync(hostPath);

      const uploadArgs: Record<string, unknown> = {
        token: SLACK_BOT_TOKEN,
        channel_id: parsed.channel,
        file: fileContent,
        filename: title || path.basename(filePath),
        title: title || path.basename(filePath),
      };
      if (parsed.threadTs) {
        uploadArgs.thread_ts = parsed.threadTs;
      }
      await this.app.client.filesUploadV2(uploadArgs as unknown as Parameters<typeof this.app.client.filesUploadV2>[0]);
      logger.info({ jid, filePath, title }, 'Slack file uploaded');
    } catch (err) {
      logger.error({ err, jid, filePath }, 'Failed to upload Slack file');
    }
  }

  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    try {
      await this.app.client.reactions.add({
        token: SLACK_BOT_TOKEN,
        channel,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (err) {
      // already_reacted is not an error
      const errorCode = (err as { data?: { error?: string } })?.data?.error;
      if (errorCode !== 'already_reacted') {
        logger.warn({ err, channel, messageTs, emoji }, 'Failed to add reaction');
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  private parseJid(jid: string): { channel: string; threadTs?: string } | null {
    const parts = jid.split(':');
    if (parts.length < 2 || parts[0] !== 'slack') return null;
    return {
      channel: parts[1],
      threadTs: parts.length >= 3 ? parts[2] : undefined,
    };
  }

  private async flushOutgoingQueue(): Promise<void> {
    while (this.outgoingQueue.length > 0) {
      const item = this.outgoingQueue.shift()!;
      try {
        await this.sendMessage(item.jid, item.text);
      } catch (err) {
        logger.warn({ jid: item.jid, err }, 'Failed to flush queued Slack message');
      }
    }
  }
}
