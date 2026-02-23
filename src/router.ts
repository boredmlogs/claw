import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    // Include message ID for Slack messages so agents can react to them
    const idAttr = m.chat_jid.startsWith('slack:') ? ` ts="${escapeXml(m.id)}"` : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"${idAttr}>${escapeXml(m.content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * Resolve a thread JID to its parent channel JID.
 * slack:C123:thread_ts → slack:C123
 * All other JIDs pass through unchanged.
 */
export function resolveGroupJid(chatJid: string): string {
  const parts = chatJid.split(':');
  if (parts.length === 3 && parts[0] === 'slack') {
    return `${parts[0]}:${parts[1]}`;
  }
  return chatJid;
}
