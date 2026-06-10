/**
 * Global footer injector.
 *
 * Adds a small "Developed by Dimie Ogoina" credit line at the bottom of every
 * page that includes this script. We do it with JS rather than copying the
 * markup into six different HTML files so there is exactly one place to edit.
 *
 * Cosmetic only — no data, no auth, no network calls.
 */
(function () {
    if (document.getElementById('bmu-global-footer')) return; // idempotent

    // Inject minimal styles once so we don't depend on each page's CSS file.
    const style = document.createElement('style');
    style.textContent = `
        #bmu-global-footer {
            position: relative;
            margin-top: 32px;
            padding: 14px 16px;
            text-align: center;
            font-size: 0.82rem;
            color: rgba(255,255,255,0.75);
            background: transparent;
        }
        body.has-light-footer #bmu-global-footer {
            color: rgba(40,60,60,0.7);
        }
        #bmu-global-footer .sep { opacity: 0.5; margin: 0 6px; }
        /* Make sure the chat / app shells leave room for it */
        body { padding-bottom: 0; }
    `;
    document.head.appendChild(style);

    const render = () => {
        if (document.getElementById('bmu-global-footer')) return;
        const f = document.createElement('footer');
        f.id = 'bmu-global-footer';
        f.setAttribute('role', 'contentinfo');
        const year = new Date().getFullYear();
        f.innerHTML =
            `<span>&copy; ${year} Bayelsa Medical University</span>` +
            `<span class="sep">&middot;</span>` +
            `<span>Developed by <strong>Dimie Ogoina</strong></span>`;
        document.body.appendChild(f);

        // Pick a contrasting colour based on the page's actual background so
        // the credit reads correctly on both the dark landing page and the
        // light admin/advisor shells.
        try {
            const bg = getComputedStyle(document.body).backgroundColor || '';
            const m = bg.match(/\d+/g);
            if (m && m.length >= 3) {
                const [r, g, b] = m.map(Number);
                // Rec. 601 luma — > ~150 means a light surface.
                const luma = 0.299 * r + 0.587 * g + 0.114 * b;
                if (luma > 150) document.body.classList.add('has-light-footer');
            }
        } catch (_) { /* ignore */ }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render, { once: true });
    } else {
        render();
    }
})();
