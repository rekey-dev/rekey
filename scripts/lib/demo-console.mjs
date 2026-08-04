/**
 * A terminal + editor "screen" rendered as an HTML page and filmed with
 * Playwright.
 *
 * WHY NOT asciinema/agg. The two framework walkthroughs are terminal- and
 * editor-heavy, and Playwright can only record a browser page. The obvious
 * alternative was `asciinema` + `agg`, which films a genuine TTY. It was
 * rejected for three reasons:
 *
 *   1. Both walkthroughs have to cut from a terminal to a REAL BROWSER (the
 *      Next.js app signing a user up, the operator panel showing that user).
 *      asciinema cannot film a browser, so those videos would have to be two
 *      recordings stitched in ffmpeg — two clocks, two frame rates, a seam.
 *      Rendering the terminal into the same Playwright page means one
 *      continuous take, and the cut to the live app is just a `page.goto`.
 *   2. It is a second toolchain (a Rust binary and a Python package) that
 *      nobody has installed, on top of the ffmpeg + Playwright the repo
 *      already requires for `pnpm demo:record`.
 *   3. Its visual language — a real font, a real cursor, a real palette — is
 *      not the panel walkthrough's, and these three videos sit on the same
 *      site. Here the caption bar, the colours and the encoder settings are
 *      literally the same code.
 *
 * The commands are REAL. `run()` spawns the process, waits for it, and streams
 * its actual stdout/stderr into the pane. Nothing on screen is typed prose
 * pretending to be output — if `npm install` prints a different summary
 * tomorrow, the next recording shows the different summary.
 *
 * SECRETS. Every string that reaches the DOM goes through `redact()` at one
 * choke point (`push`), which masks Application keys and JWTs. Unlike the panel
 * video — which has to blur a value the panel itself renders — the secret is
 * never in the document at all, so there is no frame to catch it in. The CSS
 * blur rule is kept anyway, injected before first paint, as a second line of
 * defence for anything a subprocess might print that the pattern misses.
 */

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  // Application secret keys: rp_live_… / rp_test_…
  [/\brp_(live|test)_[A-Za-z0-9_-]{6,}/g, (m) => `rp_${m.split('_')[1]}_${'•'.repeat(16)}`],
  // Anything shaped like a JWT (end-user access/refresh tokens).
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, () => `eyJ${'•'.repeat(24)}`],
];

/** Mask every credential shape before it can reach the page. */
export function redact(text) {
  let out = String(text);
  for (const [re, fn] of SECRET_PATTERNS) out = out.replace(re, (m) => fn(m));
  return out;
}

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
/**
 * The console's stylesheet.
 *
 * Deliberately NOT an `addInitScript`. Both walkthroughs navigate away to a
 * real application mid-take, and an init script would keep re-asserting
 * `html,body{background:#100d0c}` into that app's document — repainting the
 * customer's own app in the terminal's colours, on camera. It ships inside the
 * shell document instead, which `setContent` delivers atomically with the
 * markup, so there is still no unstyled first frame.
 */
const CONSOLE_CSS = `
    html,body{margin:0;height:100%;background:#100d0c;color:#e7e2de;
      font:13px/1.62 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      -webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    .scr{height:100vh;display:flex;flex-direction:column;padding:22px 26px 62px}
    .win{flex:1;min-height:0;display:flex;flex-direction:column;
      background:#171312;border:1px solid #2e2725;border-radius:11px;overflow:hidden;
      box-shadow:0 20px 60px -30px rgba(0,0,0,.9)}
    .bar{flex:none;display:flex;align-items:center;gap:8px;padding:9px 14px;
      background:#1f1a18;border-bottom:1px solid #2e2725}
    .dot{width:11px;height:11px;border-radius:50%}
    .bar .t{margin-left:8px;font-size:11.5px;color:#8b817c;letter-spacing:.02em}
    .body{flex:1;min-height:0;overflow:hidden;padding:14px 18px;position:relative}
    .body.pad0{padding:0}
    .ln{white-space:pre-wrap;word-break:break-word}
    .p{color:#6f6763}
    .cmd{color:#e7e2de}
    .out{color:#a49a94}
    .ok{color:#9fe0a0}
    .bad{color:#f0846b}
    .k{color:#e7c46b}
    .cur{display:inline-block;width:7.6px;height:15px;background:#e8552a;
      vertical-align:-3px;animation:b 1.05s steps(1) infinite}
    @keyframes b{0%,50%{opacity:1}51%,100%{opacity:0}}
    /* editor */
    .tabs{flex:none;display:flex;gap:1px;background:#1f1a18;border-bottom:1px solid #2e2725}
    .tab{padding:7px 15px;font-size:11.5px;color:#6f6763;background:#191514}
    .tab.on{color:#e7e2de;background:#171312;border-top:2px solid #e8552a;padding-top:5px}
    .code{display:grid;grid-template-columns:auto 1fr;column-gap:16px;padding:14px 18px}
    .gut{color:#453c39;text-align:right;user-select:none;white-space:pre}
    .src{white-space:pre-wrap;word-break:break-word;color:#cfd8e3}
    .kw{color:#e8968a}.str{color:#9fe0a0}.com{color:#5f5652}.fn{color:#e7c46b}
    /* belt-and-braces: anything that slips the string-level redactor */
    .secret{filter:blur(7px)!important;user-select:none!important}
  `;

/**
 * Hide Next.js's floating dev indicator.
 *
 * It pins itself to the bottom-left corner — exactly where the caption bar is —
 * and sat on top of the step number for the whole panel section of the first
 * cut. The demo app turns it off properly via `devIndicators: false` in its own
 * config; the operator panel is a real app in this repository and its config is
 * not this script's to edit, so it gets hidden at the CSS level instead.
 *
 * This removes something that exists only in `next dev`. A deployed panel has
 * no such badge, so hiding it makes the recording MORE representative, not
 * less — it is the one thing on screen that a viewer could not reproduce.
 */
export const HIDE_DEV_OVERLAY_INIT = () => {
  const ensure = () => {
    if (!document.head || document.getElementById('rk-hide-devtools')) return;
    const s = document.createElement('style');
    s.id = 'rk-hide-devtools';
    s.textContent = 'nextjs-portal,[data-nextjs-toast]{display:none!important}';
    document.head.appendChild(s);
  };
  ensure();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure);
  new MutationObserver(ensure).observe(document.documentElement, { childList: true, subtree: true });
};

/**
 * The caption bar. Identical in look and mechanism to the panel walkthrough's:
 * a fixed bar re-asserted through a MutationObserver, because Next.js swaps the
 * body on navigation and these videos DO navigate to a real app mid-take.
 */
export const CAPTION_INIT = () => {
  const ensure = () => {
    if (!document.body || document.getElementById('rk-cap')) return;
    const bar = document.createElement('div');
    bar.id = 'rk-cap';
    bar.setAttribute('aria-hidden', 'true');
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      'font:500 15px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif',
      'color:#fff', 'background:rgba(12,10,9,.92)', 'padding:13px 22px',
      'display:flex', 'gap:12px', 'align-items:center',
      'backdrop-filter:blur(6px)', 'opacity:0', 'transition:opacity .28s ease',
      'pointer-events:none', 'letter-spacing:.01em',
    ].join(';');
    bar.innerHTML =
      '<span id="rk-cap-n" style="flex:none;background:#e8552a;border-radius:999px;' +
      'padding:2px 10px;font-size:12px;font-weight:700;letter-spacing:.04em"></span>' +
      '<span id="rk-cap-t"></span>';
    document.body.appendChild(bar);
  };
  const boot = () => {
    ensure();
    new MutationObserver(ensure).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.__rkCap = (n, t) => {
    ensure();
    const bar = document.getElementById('rk-cap');
    if (!bar) return;
    document.getElementById('rk-cap-n').textContent = n;
    document.getElementById('rk-cap-t').textContent = t;
    bar.style.opacity = '1';
  };
};

const SHELL_HTML = `<meta charset="utf-8"><style>${CONSOLE_CSS}</style>
<div class="scr"><div class="win">
  <div class="bar">
    <span class="dot" style="background:#f0846b"></span>
    <span class="dot" style="background:#e7c46b"></span>
    <span class="dot" style="background:#9fe0a0"></span>
    <span class="t" id="win-title"></span>
  </div>
  <div class="body" id="win-body"></div>
</div></div>`;

// ---------------------------------------------------------------------------
// Very small syntax tint. Deliberately not a real highlighter: it only has to
// survive TypeScript and dotenv, and a dependency for this would be silly.
// ---------------------------------------------------------------------------
const KEYWORDS =
  /\b(import|from|export|default|const|let|async|await|function|return|class|implements|new|throw|if|else|try|catch|typeof|extends|interface|type|as)\b/g;

/**
 * Tokenize the line FIRST, then emit — never run replacements over markup this
 * function already produced.
 *
 * The chained-`String.replace` version of this was subtly broken in a way worth
 * recording: `class` is a TypeScript keyword, so the keyword pass happily
 * rewrote the `class` inside the `<span class="str">` that the string pass had
 * just inserted, producing `<span <span class="kw">class</span>="str">`. The
 * browser parsed that as a malformed tag, swallowed the opening `<span `, and
 * rendered a literal `class="str">` in the middle of every import line — on
 * camera, in the first cut.
 */
function tint(line) {
  const src = String(line);
  let out = '';
  let i = 0;
  let plain = '';

  const flushPlain = () => {
    if (!plain) return;
    out += esc(plain)
      .replace(KEYWORDS, '<span class="kw">$1</span>')
      .replace(/@([A-Za-z][\w.-]*)/g, '<span class="fn">@$1</span>');
    plain = '';
  };

  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    // Comment — runs to end of line, nothing inside it is tinted further.
    // `src[i - 1] !== ':'` keeps `http://…` out of it; a .env file full of URLs
    // otherwise renders as one long grey comment from the scheme onwards.
    if ((rest.startsWith('//') && src[i - 1] !== ':') || ch === '#') {
      flushPlain();
      out += `<span class="com">${esc(rest)}</span>`;
      return out;
    }

    // String literal, single or double quoted, no escape handling needed for
    // the code these walkthroughs show.
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = src.indexOf(ch, i + 1);
      if (end !== -1) {
        flushPlain();
        out += `<span class="str">${esc(src.slice(i, end + 1))}</span>`;
        i = end + 1;
        continue;
      }
    }

    plain += ch;
    i += 1;
  }
  flushPlain();
  return out;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
/**
 * Wraps a Playwright page as a terminal/editor screen.
 *
 * @param page       Playwright Page (already carrying the two init scripts)
 * @param opts.cwdLabel  what the prompt shows, e.g. "~/northwind"
 * @param opts.steps     total step count, for the caption pill ("2/6")
 */
export function createConsole(page, { cwdLabel, steps }) {
  let step = 0;

  const evalPage = (fn, arg) => page.evaluate(fn, arg);

  return {
    /** Reset to an empty terminal window. */
    async open(title) {
      await page.setContent(SHELL_HTML);
      await evalPage((t) => {
        document.getElementById('win-title').textContent = t;
      }, redact(title));
    },

    async caption(text) {
      step += 1;
      await evalPage(
        ([n, t]) => window.__rkCap?.(n, t),
        [`${step}/${steps}`, text],
      );
    },

    async recaption(text) {
      await evalPage(([n, t]) => window.__rkCap?.(n, t), [`${step}/${steps}`, text]);
    },

    /** Animate a shell prompt + command, character by character. */
    async typeCommand(cmd, { delay = 26 } = {}) {
      const safe = redact(cmd);
      await evalPage((p) => {
        const b = document.getElementById('win-body');
        const el = document.createElement('div');
        el.className = 'ln';
        el.innerHTML = `<span class="p">${p} $</span> <span class="cmd"></span><span class="cur"></span>`;
        b.appendChild(el);
        window.__rkLine = el.querySelector('.cmd');
        b.scrollTop = b.scrollHeight;
      }, cwdLabel);
      for (const ch of safe) {
        await evalPage((c) => {
          window.__rkLine.textContent += c;
        }, ch);
        await new Promise((r) => setTimeout(r, delay));
      }
      await evalPage(() => {
        document.querySelectorAll('.cur').forEach((c) => c.remove());
      });
    },

    /** Append output lines. `cls` picks the colour (out / ok / bad / k). */
    async print(text, { cls = 'out', pause = 0 } = {}) {
      await evalPage(
        ([t, c]) => {
          const b = document.getElementById('win-body');
          for (const line of t.split('\n')) {
            const el = document.createElement('div');
            el.className = `ln ${c}`;
            el.textContent = line;
            b.appendChild(el);
          }
          b.scrollTop = b.scrollHeight;
        },
        [redact(text), cls],
      );
      if (pause) await new Promise((r) => setTimeout(r, pause));
    },

    /** Blank line. */
    async blank() {
      await evalPage(() => {
        const b = document.getElementById('win-body');
        b.appendChild(Object.assign(document.createElement('div'), { className: 'ln', textContent: ' ' }));
        b.scrollTop = b.scrollHeight;
      });
    },

    /** Keep only the last `n` lines, so a long install does not push the
     *  prompt off screen mid-take. */
    async trimTo(n) {
      await evalPage((keep) => {
        const b = document.getElementById('win-body');
        while (b.children.length > keep) b.removeChild(b.firstChild);
      }, n);
    },

    /** Swap the window into an editor showing one file. Types it in. */
    async showFile(filename, contents, { delay = 6, header } = {}) {
      const lines = redact(contents).replace(/\n$/, '').split('\n');
      await evalPage(
        ([name, hdr]) => {
          document.getElementById('win-title').textContent = hdr;
          const b = document.getElementById('win-body');
          b.className = 'body pad0';
          b.innerHTML =
            `<div class="tabs"><div class="tab on">${name}</div></div>` +
            '<div class="code"><div class="gut" id="gut"></div><div class="src" id="src"></div></div>';
        },
        [esc(filename), redact(header ?? filename)],
      );
      for (let i = 0; i < lines.length; i += 1) {
        await evalPage(
          ([html, n]) => {
            document.getElementById('gut').textContent += `${n}\n`;
            const el = document.createElement('div');
            el.innerHTML = html || '&nbsp;';
            document.getElementById('src').appendChild(el);
          },
          [tint(lines[i]), i + 1],
        );
        await new Promise((r) => setTimeout(r, delay * Math.max(1, lines[i].length / 8)));
      }
    },

    /** Back to a terminal window after `showFile`. */
    async backToTerminal(title) {
      await evalPage((t) => {
        document.getElementById('win-title').textContent = t;
        const b = document.getElementById('win-body');
        b.className = 'body';
        b.innerHTML = '';
      }, redact(title));
    },
  };
}
