// Wandergeek toggle primitive.
//
// Renders a pill + knob driven by a hidden <input type="checkbox"> so the
// existing change-event + id-based wiring in app.js (the
// document.getElementById('<feature>-feature-toggle').addEventListener block
// near loadSettings()) keeps binding without modification. The unchecked
// state uses the inset gloss
// gradient; the checked state flips the pill to the sun gradient, matching
// the `.wg-gloss--sun` convention used for primary actions everywhere else.
//
// API:
//   WGToggle.render({ id, checked, disabled, ariaLabel, onToggle }) -> HTMLElement
//
// The returned element is a <label class="wg-toggle"> containing a hidden
// `<input type="checkbox" id="...">`, a track, and a knob. The hidden input
// is the source of truth for state — callers can still do
// `document.getElementById(id).checked` and listen for `change`.

(function () {
    function renderToggle({ id, checked, disabled, ariaLabel, onToggle } = {}) {
        const label = document.createElement('label');
        label.className = 'wg-toggle';
        if (disabled) {
            label.classList.add('wg-toggle--disabled');
        }

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'wg-toggle__input';
        if (id) input.id = id;
        if (checked) input.checked = true;
        if (disabled) input.disabled = true;
        if (ariaLabel) input.setAttribute('aria-label', ariaLabel);

        const track = document.createElement('span');
        track.className = 'wg-toggle__track';
        track.setAttribute('aria-hidden', 'true');

        const knob = document.createElement('span');
        knob.className = 'wg-toggle__knob';
        knob.setAttribute('aria-hidden', 'true');

        if (typeof onToggle === 'function') {
            input.addEventListener('change', (e) => {
                onToggle(e.target.checked, e);
            });
        }

        label.appendChild(input);
        label.appendChild(track);
        label.appendChild(knob);
        return label;
    }

    window.WGToggle = { render: renderToggle };
})();
