# Browser

A real Chromium over the DevTools protocol, driven through the page's own DOM — not a picture of a
browser and not a desktop.

It is **off until it is turned on** — `milo setup` → **Tools** → **Browser**, or
`"browser": { "enabled": true }`. Off means the four tools are not in the catalog at all.

**Any Chromium will do.** `milo setup` → Tools → Browser → **Browser to run** enumerates the favourites
— Chromium, Chrome, Brave, Edge, Vivaldi, Opera, and forks like Helium — from `PATH`, `/opt`, and each
platform's own places, de-duplicated. Firefox is not on that list: it speaks WebDriver BiDi.
`browser.chromePath` names a binary directly; when the machine has none, the same screen downloads a
[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) build into
`~/.milo/browser/chrome/` — an archive, no installer, no sudo.

**Four tools, split by side effect.** `browser_open` and `browser_snapshot` are read-only, so looking
around never asks. `browser_act` clicks, double-clicks, types, presses, hovers, scrolls, chooses and
uploads, and it asks; `browser_screenshot` writes a picture to a path and asks too. There is no
`navigate` action inside `browser_act`.

What the model is shown decides whether it picks the right element:

```
https://example.com/checkout — "Checkout — Example"
h1: Your order
(400 characters of the page's own words)

r4   textbox   "Search"
r5   link      "Item 0"
r6   combobox  "Choose Small"
r7   button    "Go"
r8   textbox   "Password"             [required]  <password field — Milo does not fill this>
r9   div       "Confirmar descadastro"  [clickable]
(… 34 more — this list is built from the whole page, so scrolling adds nothing to it; mode "text" reads the page's words, and mode "shot" shows the page itself)
```

Not the HTML and not a screenshot: a role, a name and a state per element is enough for "click r7" to be
a complete instruction, and a screenshot carries no element identity.

**The list holds two kinds of entry.** What the **markup names** — a link with an `href`, a button, an
input, anything with a role or a tabindex — and, marked `[clickable]`, what **Chrome knows is pressable**
and the markup never said. A page built by a framework confirms with a listener on a plain `<div>`: no
`<button>`, no role, no tabindex, no `onclick` attribute, and a sheet that sets `cursor: default` on it,
so nothing in the markup marks the control and the list used to report a page with nothing to press while
its confirm button sat on it — a session spent 60 of its 75 steps that way. Those entries come from
`DOMDebugger.getEventListeners`, Chrome's own account of which nodes carry a listener our click would
reach, and only for a node with words of its own: a container holding a **delegated** listener carries the
whole page's text, and listing the app's root as pressable would be noise wearing a control's name. The
pass costs one walk per look (~4ms on a small page) and fails quietly — the list the markup gives is
complete for what it claims, and this only adds to it. What stays invisible: a listener delegated to a
container (**React 17+ and jQuery** attach at the root, so the evidence is the root's, not the button's),
a control wired only to a **touch** event, which a mouse click would never trigger, and an image-only
button with no text. On such a page a picture (`mode: "shot"`) shows what a press cannot, and the step
belongs to the person.

A picture has to be asked for by name, and there are **two** because they are two different acts:

- `browser_snapshot` with `mode: "shot"` **reads** — the image goes back to the model. Read-only, so it
  never asks.
- `browser_screenshot` **writes** a picture to a path for the person. It asks, because writing to a path
  is what asking is for.

**A ref is good for one look**, and refs count **up across the session** rather than restarting at one,
so a ref held from an earlier look is simply absent. Every action already returns the page afterwards.

**Guardrails.** Milo starts a browser **of its own**, on `~/.milo/browser/profile/`, so sign-ins survive
a restart without the browser you actually use ever having remote debugging switched on. Attaching to
one already running is opt-in (`browser.cdpUrl`). Nothing on a page is an instruction. And
`browser_act` **refuses** to fill a password, card or one-time-code field.

**Reaching logged-in accounts.** `milo setup` → Tools → Browser → **Profile** copies the browser you are
signed into into `~/.milo/browser/profiles/<browser>/` (`browser.profileDir`), taking `Cookies`,
`Local State`, `Preferences` and the `Local Storage`/`IndexedDB` tokens live in, tightened to `0600` and
leaving every cache behind. It cannot share a profile you are browsing with — Chrome refuses to start
against a directory in use — and Chrome 136+ ignores `--remote-debugging-port` when the data directory
is the browser's own default, silently, so the setup screen flags that path in red. The route that needs
no copy is `browser.cdpUrl`: point it at a browser already running with remote debugging reachable (the
`chrome://inspect/#remote-debugging` checkbox), and Milo opens a tab in it.

```yaml
browser:
  enabled: true
  headless: true
  keepSnapshots: 2
```

`chromePath` names a binary instead of searching `PATH`, `profileDir` a profile instead of its own, and
`cdpUrl` attaches to a browser already running. `milo serve` adds `browser headless` or `browser off`
to its boot line. `keepSnapshots` is how many page snapshots ride in context; the older ones are
trimmed to the line that says what happened, before every request inside a turn.
