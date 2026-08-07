import DOMPurify from 'dompurify'

/**
 * 安全的 JSON.parse，解析失败时返回 fallback，避免数据库字段损坏导致整批数据加载崩溃。
 */
export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch (err) {
    console.error('[safeJsonParse] 解析失败，使用 fallback:', err)
    return fallback
  }
}

/**
 * 对 markdown 渲染前的 HTML 进行消毒，防止 XSS。
 * 允许常见 markdown 标签，移除 script/事件处理器/javascript: 协议。
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a',
      'b',
      'i',
      'em',
      'strong',
      'code',
      'pre',
      'blockquote',
      'p',
      'br',
      'hr',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'img',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'span',
      'div',
      'del',
      'ins',
      'sub',
      'sup',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  })
}
