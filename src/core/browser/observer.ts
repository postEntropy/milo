/**
 * What the model is shown of a page.
 *
 * Not the HTML, and not a picture. A picture costs ~1500 tokens of prefill on
 * every step after it and carries no element identity, so acting on it is
 * guessing at coordinates. The raw DOM is worse: it is mostly markup the model
 * has to read past. What is left, and what this builds, is the short list of
 * things that can actually be acted on — a role, a name and a state per element,
 * numbered, so "click r12" is a complete instruction.
 *
 * Refs are minted per observation and mean nothing afterwards. That is
 * deliberate: a ref that survived an action would eventually describe an element
 * that has moved or gone, and a click on the wrong element is worse than an
 * error that says "look again".
 */

/** How many elements one observation shows. Past this the page is read, not driven. */
export const MAX_ELEMENTS = 120

/** The role column, padded so the names line up and a list stays scannable. */
const ROLE_WIDTH = 10

/** An element's name, cut: a link's text can be a paragraph. */
const NAME_LIMIT = 60

/** Characters of the page's own words, enough to know what this page is. */
const TEXT_LIMIT = 400

export interface RawElement {
  ref: string
  role: string
  name: string
  state: string
  /** Non-null when the element takes a password, a card or a one-time code. */
  sensitive: string | null
}

export interface RawObservation {
  url: string
  title: string
  heading: string
  text: string
  textTruncated: boolean
  frame: string
  elements: RawElement[]
}

/**
 * The function Chrome runs, as source.
 *
 * A function and not a snippet because it is called once per frame with the
 * frame's own label and the ref number it should start from — refs have to be
 * unique across every frame of the page, and each frame has its own global
 * object to hang the element registry on.
 */
const OBSERVER = String.raw`
function (frame, base, nonce) {
  var seen = 0
  var found = []
  var registry = {}
  var SELECTOR = 'a[href],button,input,select,textarea,summary,[role],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])'
  var MAX_ELEMENTS = __MAX_ELEMENTS__
  var MAX_VISITED = 8000
  var NAME_LIMIT = __NAME_LIMIT__

  function visible(el) {
    if (el.hidden) return false
    var rects = el.getClientRects()
    if (rects.length === 0) return false
    var style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (style.opacity === '0') return false
    return true
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role')
    if (explicit && explicit.trim()) return explicit.trim()
    var tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'hidden') return 'hidden'
      if (type === 'file') return 'file'
      return 'textbox'
    }
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'img') return 'img'
    return tag
  }

  function nameOf(el, role) {
    var aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria

    var labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      var parts = labelledBy.split(/\s+/).map(function (id) {
        var node = document.getElementById(id)
        return node ? (node.innerText || node.textContent || '') : ''
      }).join(' ')
      if (parts.trim()) return parts
    }

    if (el.labels && el.labels.length) {
      var text = ''
      for (var i = 0; i < el.labels.length; i++) text += ' ' + (el.labels[i].innerText || el.labels[i].textContent || '')
      if (text.trim()) return text
    }

    var tag = el.tagName.toLowerCase()
    if (tag === 'img' || tag === 'input') {
      var alt = el.getAttribute('alt')
      if (alt && alt.trim()) return alt
    }

    if (tag === 'input' || tag === 'textarea') {
      var placeholder = el.getAttribute('placeholder')
      if (placeholder && placeholder.trim()) return placeholder
    }

    var inner = el.innerText || el.textContent || ''
    if (inner.trim()) return inner
    if (el.value && typeof el.value === 'string' && el.value.trim()) return el.value

    var title = el.getAttribute('title')
    if (title && title.trim()) return title
    var value = el.getAttribute('value')
    if (value && value.trim()) return value
    return ''
  }

  function sensitiveOf(el) {
    var type = (el.getAttribute('type') || '').toLowerCase()
    if (type === 'password') return 'password'
    var auto = (el.getAttribute('autocomplete') || '').toLowerCase()
    if (/^(cc-|new-password$|current-password$|one-time-code$)/.test(auto)) return 'credential'
    var hint = ((el.getAttribute('name') || '') + ' ' + (el.getAttribute('id') || '')).toLowerCase()
    if (/(^|[^a-z])(password|passwd|pwd|otp|totp|cvv|cvc|iban|cardnumber|card-number|securitycode|security-code|secret)([^a-z]|$)/.test(hint)) return 'credential'
    return null
  }

  function stateOf(el, role) {
    var bits = []
    if (el.disabled) bits.push('disabled')
    if (el.readOnly) bits.push('readonly')
    if (el.required) bits.push('required')
    if (role === 'checkbox' || role === 'radio') bits.push(el.checked ? 'checked' : 'unchecked')
    if (el.tagName === 'OPTION' && el.selected) bits.push('selected')
    var expanded = el.getAttribute('aria-expanded')
    if (expanded === 'true') bits.push('expanded')
    else if (expanded === 'false') bits.push('collapsed')
    var checked = el.getAttribute('aria-checked')
    if (checked === 'true' || checked === 'false') bits.push(checked === 'true' ? 'checked' : 'unchecked')
    if (el.multiple) bits.push('multiple')
    if (role === 'textbox' || role === 'combobox') {
      if (el.value && typeof el.value === 'string' && el.value.trim()) bits.push('value="' + el.value.trim().slice(0, 40) + '"')
    }
    return bits.join(', ')
  }

  function walk(root, label) {
    var all
    try { all = root.querySelectorAll('*') } catch (e) { return }
    for (var i = 0; i < all.length; i++) {
      if (seen >= MAX_VISITED || found.length >= MAX_ELEMENTS) return
      seen++
      var el = all[i]
      var matches = false
      try { matches = el.matches(SELECTOR) } catch (e) { matches = false }
      if (matches && visible(el)) {
        var role = roleOf(el)
        if (role !== 'hidden') found.push({ el: el, role: role, name: nameOf(el, role), state: stateOf(el, role), sensitive: sensitiveOf(el) })
      }
      if (el.shadowRoot) walk(el.shadowRoot, label)
    }
  }

  if (document.body) walk(document.body, frame)

  var elements = []
  for (var i = 0; i < found.length; i++) {
    var ref = 'r' + (base + i + 1)
    // Keyed by the observation it belongs to: a ref from an earlier look must not
    // resolve to whatever element happens to sit at that number now.
    registry[nonce + ':' + ref] = found[i].el
    var name = found[i].name.replace(/\s+/g, ' ').trim()
    if (name.length > NAME_LIMIT) name = name.slice(0, NAME_LIMIT - 1) + '…'
    elements.push({ ref: ref, role: found[i].role, name: name, state: found[i].state, sensitive: found[i].sensitive })
  }
  globalThis.__miloRefs = registry

  var body = document.body ? (document.body.innerText || '') : ''
  var flat = body.replace(/\s+/g, ' ').trim()
  var headingNode = document.querySelector('h1')
  var heading = headingNode ? (headingNode.innerText || headingNode.textContent || '').replace(/\s+/g, ' ').trim() : ''

  return {
    url: location.href,
    title: document.title,
    heading: heading,
    text: flat.slice(0, __TEXT_LIMIT__),
    textTruncated: flat.length > __TEXT_LIMIT__,
    frame: frame,
    elements: elements,
    more: found.length >= MAX_ELEMENTS
  }
}
`

/**
 * The function source, with this module's constants baked in.
 *
 * Every occurrence, not the first: a placeholder that survives into the page
 * becomes a `ReferenceError` in a script nobody can see, and the only symptom is
 * a page reported as unreadable. A token appearing twice is the normal case — the
 * text limit is used once to cut and once to decide whether it was cut.
 */
export const OBSERVER_SOURCE = (
  [
    ['__MAX_ELEMENTS__', MAX_ELEMENTS],
    ['__NAME_LIMIT__', NAME_LIMIT],
    ['__TEXT_LIMIT__', TEXT_LIMIT],
  ] as const
).reduce((source, [token, value]) => source.replaceAll(token, String(value)), OBSERVER)

/** The expression to evaluate in one frame's realm. */
export function observeExpression(frame: string, base: number, nonce: string): string {
  return `(${OBSERVER_SOURCE})(${JSON.stringify(frame)}, ${base}, ${JSON.stringify(nonce)})`
}

/** How the element behind a ref is looked up again, in the realm that minted it. */
export function refExpression(nonce: string, ref: string): string {
  return `globalThis.__miloRefs[${JSON.stringify(`${nonce}:${ref}`)}]`
}

/** What a frame reported, before the frames are stitched together. */
export interface FrameObservation extends Omit<RawObservation, 'elements'> {
  elements: RawElement[]
  more: boolean
}

export interface Observation {
  url: string
  title: string
  heading: string
  text: string
  textTruncated: boolean
  elements: RawElement[]
  /** Elements that existed but did not fit, so the model knows to look closer. */
  more: boolean
  /** Frames that could not be read, named — a silent gap is a wrong answer. */
  unread: string[]
}

/** Stitches the frames of one page into the single observation the model sees. */
export function mergeObservations(frames: FrameObservation[], unread: string[] = []): Observation {
  const first = frames[0]
  const elements: RawElement[] = []
  let more = false
  for (const frame of frames) {
    elements.push(...frame.elements)
    if (frame.more) more = true
  }
  return {
    url: first?.url ?? '',
    title: first?.title ?? '',
    heading: frames.find((frame) => frame.heading)?.heading ?? '',
    text: first?.text ?? '',
    textTruncated: first?.textTruncated ?? false,
    elements: elements.slice(0, MAX_ELEMENTS),
    more: more || elements.length > MAX_ELEMENTS,
    unread,
  }
}

/** The observation as the model reads it. */
export function formatSnapshot(observation: Observation): string {
  const lines: string[] = []
  const where = [observation.url, observation.title ? `"${observation.title}"` : '']
    .filter(Boolean)
    .join(' — ')
  if (where) lines.push(where)
  if (observation.heading) lines.push(`h1: ${observation.heading}`)
  if (observation.text) {
    lines.push(observation.textTruncated ? `${observation.text}…` : observation.text)
  }

  if (observation.elements.length === 0) {
    lines.push('(no interactive elements on this page)')
  } else {
    lines.push('')
    lines.push(observation.elements.map(formatElement).join('\n'))
  }

  if (observation.more) {
    lines.push(
      `(only the first ${observation.elements.length} elements are shown — scroll or use mode "text" to see more of the page)`,
    )
  }
  if (observation.unread.length > 0) {
    lines.push(`(could not read: ${observation.unread.join(', ')})`)
  }
  return lines.join('\n')
}

/** One element, in the columns the model scans: ref, role, name, state. */
export function formatElement(element: RawElement): string {
  const role = element.role.padEnd(ROLE_WIDTH, ' ')
  const name = element.name ? `"${element.name}"` : ''
  const state = element.state ? `  [${element.state}]` : ''
  const sensitive = element.sensitive ? `  <${element.sensitive} field — Milo does not fill this>` : ''
  return `${element.ref.padEnd(5, ' ')}${role}${name}${state}${sensitive}`
}
