/**
 * Animatable SVG advisor avatars.
 *
 * Two gender-aware portraits with consistent named groups so the same
 * driver code in advisor.js can animate either one:
 *
 *   #avHead         — head + neck (subtle nod / tilt while listening)
 *   #avEyes         — both eyes, with #avLidL / #avLidR for blinks
 *   #avPupils       — pupils (independent transform for gaze drift)
 *   #avMouth        — mouth path (lip-sync openness + smile/frown shape)
 *   #avBrows        — both brows (#avBrowL / #avBrowR — for raise / furrow)
 *   #avTorso        — coat/dress (breath/sway during speaking)
 *   #avHandL/R      — hands (small motion when emphasising)
 *
 * The mouth uses a single <path> instead of an ellipse so we can morph
 * between flat / open / smile / frown by recomputing the d= attribute.
 * That gives genuine expressive range without bringing in a 200 KB Lottie.
 */
(function () {
    'use strict';

    // ---- shared palette -------------------------------------------------
    const SKIN_F = '#a07150'; // warmer brown (female advisor)
    const SKIN_F_DARK = '#7a5236';
    const SKIN_M = '#8a5a3a'; // slightly darker / cooler (male advisor)
    const SKIN_M_DARK = '#5e3b22';
    const HAIR = '#1d1612';
    const COAT = '#ffffff';
    const COAT_SHADOW = '#dfe7e9';
    const SUIT = '#143638';      // BMU teal
    const TIE  = '#23b6a5';
    const SCRUB = '#0f3d3e';

    /** Build the female advisor — head wrap, hoop earrings, white coat,
     *  warm smile. */
    function femaleAvatarSVG() {
        return `
        <svg id="avatarSvg" viewBox="0 0 220 280" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
                <radialGradient id="bgGlowF" cx="50%" cy="40%" r="60%">
                    <stop offset="0%"  stop-color="#7bdcb5" stop-opacity="0.55"/>
                    <stop offset="100%" stop-color="#0f3d3e" stop-opacity="0"/>
                </radialGradient>
                <linearGradient id="skinF" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="${SKIN_F}"/>
                    <stop offset="100%" stop-color="${SKIN_F_DARK}"/>
                </linearGradient>
                <linearGradient id="coatF" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="${COAT}"/>
                    <stop offset="100%" stop-color="${COAT_SHADOW}"/>
                </linearGradient>
                <linearGradient id="wrapF" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="#3a1c4a"/>
                    <stop offset="50%" stop-color="#7b2e58"/>
                    <stop offset="100%" stop-color="#c64a73"/>
                </linearGradient>
            </defs>

            <!-- soft glow halo -->
            <circle cx="110" cy="120" r="115" fill="url(#bgGlowF)"/>

            <!-- ============= TORSO (coat) ============= -->
            <g id="avTorso">
                <!-- shoulders / coat -->
                <path d="M22 270 Q110 195 198 270 L198 280 L22 280 Z"
                      fill="url(#coatF)" stroke="#b9c3c6" stroke-width="1"/>
                <!-- inner blouse -->
                <path d="M82 215 L110 250 L138 215 Z" fill="${TIE}"/>
                <!-- coat lapels -->
                <path d="M70 230 L92 265 L88 220 Z" fill="${COAT_SHADOW}" stroke="#b9c3c6"/>
                <path d="M150 230 L128 265 L132 220 Z" fill="${COAT_SHADOW}" stroke="#b9c3c6"/>
                <!-- BMU teal collar pin -->
                <circle cx="92" cy="226" r="2.5" fill="${TIE}"/>
                <!-- name badge -->
                <rect x="135" y="245" width="32" height="14" rx="2" fill="${TIE}"/>
                <text x="151" y="255" text-anchor="middle"
                      font-family="Inter, sans-serif" font-size="8"
                      font-weight="700" fill="#fff">BMU</text>

                <!-- ============= HANDS ============= -->
                <!-- The hands are part of the torso so they sway with the
                     coat. They live near the coat hem and are used by JS
                     for an emphasis wave during speaking. -->
                <g id="avHandL" transform="translate(50 268) rotate(0)">
                    <ellipse cx="0" cy="0" rx="9" ry="6" fill="url(#skinF)"/>
                </g>
                <g id="avHandR" transform="translate(170 268) rotate(0)">
                    <ellipse cx="0" cy="0" rx="9" ry="6" fill="url(#skinF)"/>
                </g>
            </g>

            <!-- ============= HEAD (animatable as a unit) ============= -->
            <g id="avHead" transform="translate(0 0) rotate(0 110 130)">
                <!-- neck -->
                <rect x="94" y="178" width="32" height="28" fill="url(#skinF)"/>
                <path d="M94 200 Q110 210 126 200 L126 210 L94 210 Z" fill="${SKIN_F_DARK}"/>

                <!-- earrings -->
                <circle cx="62" cy="138" r="4" fill="#e7c64e" stroke="#a98c1c"/>
                <circle cx="158" cy="138" r="4" fill="#e7c64e" stroke="#a98c1c"/>

                <!-- head outline (oval) -->
                <ellipse cx="110" cy="128" rx="48" ry="58" fill="url(#skinF)"/>

                <!-- head-wrap (gele-style, soft folds) -->
                <path d="M58 115 Q70 55 110 50 Q150 55 162 115 Q155 95 110 92 Q65 95 58 115 Z"
                      fill="url(#wrapF)"/>
                <path d="M58 100 Q90 70 130 75 Q150 80 162 110"
                      fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="2"/>
                <path d="M70 88 Q110 60 150 88" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="3"/>

                <!-- ============= BROWS ============= -->
                <g id="avBrows" stroke="${HAIR}" stroke-width="3" fill="none" stroke-linecap="round">
                    <path id="avBrowL" d="M82 118 Q92 113 102 118"/>
                    <path id="avBrowR" d="M118 118 Q128 113 138 118"/>
                </g>

                <!-- ============= EYES ============= -->
                <g id="avEyes">
                    <ellipse class="eye-white" cx="92"  cy="130" rx="9" ry="7" fill="#ffffff"/>
                    <ellipse class="eye-white" cx="128" cy="130" rx="9" ry="7" fill="#ffffff"/>
                    <g id="avPupils">
                        <circle id="avPupilL" cx="92"  cy="131" r="3.4" fill="${HAIR}"/>
                        <circle id="avPupilR" cx="128" cy="131" r="3.4" fill="${HAIR}"/>
                        <circle cx="93"  cy="129.5" r="1" fill="#fff" opacity=".9"/>
                        <circle cx="129" cy="129.5" r="1" fill="#fff" opacity=".9"/>
                    </g>
                    <!-- eyelids — slide down on blink -->
                    <rect id="avLidL" x="83" y="115" width="18" height="0" fill="url(#skinF)"/>
                    <rect id="avLidR" x="119" y="115" width="18" height="0" fill="url(#skinF)"/>
                    <!-- eyelashes (subtle) -->
                    <path d="M83 124 Q92 121 101 124" stroke="${HAIR}" stroke-width="1.5" fill="none"/>
                    <path d="M119 124 Q128 121 137 124" stroke="${HAIR}" stroke-width="1.5" fill="none"/>
                </g>

                <!-- nose -->
                <path d="M110 135 Q108 148 105 152 Q110 156 115 152 Q112 148 110 135 Z"
                      fill="${SKIN_F_DARK}" opacity=".35"/>

                <!-- ============= MOUTH (path-driven) ============= -->
                <!-- d-attribute is computed by JS — see updateMouth() in advisor.js.
                     Initial state: gentle closed smile. -->
                <g id="avMouthGroup" transform="translate(110 165)">
                    <path id="avMouth"
                          d="M -14 0 Q 0 6 14 0"
                          fill="none" stroke="#552220" stroke-width="3"
                          stroke-linecap="round"/>
                    <!-- inner mouth (used while speaking; revealed by JS) -->
                    <path id="avMouthInner"
                          d="M -10 1 Q 0 1 10 1 Q 0 1 -10 1 Z"
                          fill="#3a1f12" opacity="0"/>
                </g>

                <!-- subtle blush -->
                <ellipse cx="78" cy="148" rx="6" ry="3" fill="#cf6a78" opacity=".25"/>
                <ellipse cx="142" cy="148" rx="6" ry="3" fill="#cf6a78" opacity=".25"/>
            </g>

            <!-- listening halo — JS toggles opacity -->
            <circle id="listenRing" cx="110" cy="130" r="108" fill="none"
                    stroke="#7bdcb5" stroke-width="3" stroke-dasharray="6 8" opacity="0"/>
        </svg>`;
    }

    /** Build the male advisor — short hair, glasses, white coat over teal
     *  shirt. Same group ids so the same driver code animates it. */
    function maleAvatarSVG() {
        return `
        <svg id="avatarSvg" viewBox="0 0 220 280" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
                <radialGradient id="bgGlowM" cx="50%" cy="40%" r="60%">
                    <stop offset="0%"  stop-color="#7bdcb5" stop-opacity="0.55"/>
                    <stop offset="100%" stop-color="#0f3d3e" stop-opacity="0"/>
                </radialGradient>
                <linearGradient id="skinM" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="${SKIN_M}"/>
                    <stop offset="100%" stop-color="${SKIN_M_DARK}"/>
                </linearGradient>
                <linearGradient id="coatM" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="${COAT}"/>
                    <stop offset="100%" stop-color="${COAT_SHADOW}"/>
                </linearGradient>
            </defs>

            <circle cx="110" cy="120" r="115" fill="url(#bgGlowM)"/>

            <g id="avTorso">
                <!-- shoulders / coat -->
                <path d="M22 270 Q110 192 198 270 L198 280 L22 280 Z"
                      fill="url(#coatM)" stroke="#b9c3c6" stroke-width="1"/>
                <!-- shirt + tie -->
                <path d="M82 215 L110 250 L138 215 Z" fill="${TIE}"/>
                <rect x="103" y="218" width="14" height="36" fill="${SUIT}" rx="2"/>
                <polygon points="103,218 110,232 117,218" fill="${SUIT}"/>
                <!-- coat lapels -->
                <path d="M70 230 L92 265 L88 220 Z" fill="${COAT_SHADOW}" stroke="#b9c3c6"/>
                <path d="M150 230 L128 265 L132 220 Z" fill="${COAT_SHADOW}" stroke="#b9c3c6"/>
                <!-- BMU pocket badge -->
                <rect x="135" y="245" width="32" height="14" rx="2" fill="${TIE}"/>
                <text x="151" y="255" text-anchor="middle"
                      font-family="Inter, sans-serif" font-size="8"
                      font-weight="700" fill="#fff">BMU</text>

                <!-- HANDS -->
                <g id="avHandL" transform="translate(50 268) rotate(0)">
                    <ellipse cx="0" cy="0" rx="9" ry="6" fill="url(#skinM)"/>
                </g>
                <g id="avHandR" transform="translate(170 268) rotate(0)">
                    <ellipse cx="0" cy="0" rx="9" ry="6" fill="url(#skinM)"/>
                </g>
            </g>

            <g id="avHead" transform="translate(0 0) rotate(0 110 130)">
                <!-- neck -->
                <rect x="94" y="178" width="32" height="28" fill="url(#skinM)"/>
                <path d="M94 200 Q110 210 126 200 L126 210 L94 210 Z" fill="${SKIN_M_DARK}"/>

                <!-- ears -->
                <ellipse cx="62" cy="138" rx="6" ry="9" fill="url(#skinM)"/>
                <ellipse cx="158" cy="138" rx="6" ry="9" fill="url(#skinM)"/>

                <!-- head outline -->
                <ellipse cx="110" cy="128" rx="46" ry="56" fill="url(#skinM)"/>

                <!-- short hair (low fade with side part) -->
                <path d="M64 110 Q72 72 110 70 Q148 72 156 110 Q150 92 110 90 Q72 92 64 110 Z"
                      fill="${HAIR}"/>
                <path d="M68 100 Q90 88 110 89 Q132 90 152 102"
                      fill="none" stroke="#000" stroke-opacity=".25" stroke-width="2"/>

                <!-- glasses frames -->
                <g stroke="${SCRUB}" stroke-width="2.4" fill="none">
                    <rect x="78"  y="120" width="20" height="16" rx="3"/>
                    <rect x="122" y="120" width="20" height="16" rx="3"/>
                    <line x1="98" y1="128" x2="122" y2="128"/>
                </g>

                <!-- BROWS -->
                <g id="avBrows" stroke="${HAIR}" stroke-width="3.5" fill="none" stroke-linecap="round">
                    <path id="avBrowL" d="M80 116 Q90 112 100 116"/>
                    <path id="avBrowR" d="M120 116 Q130 112 140 116"/>
                </g>

                <!-- EYES -->
                <g id="avEyes">
                    <ellipse class="eye-white" cx="90"  cy="128" rx="7" ry="5.5" fill="#ffffff"/>
                    <ellipse class="eye-white" cx="130" cy="128" rx="7" ry="5.5" fill="#ffffff"/>
                    <g id="avPupils">
                        <circle id="avPupilL" cx="90"  cy="129" r="3" fill="${HAIR}"/>
                        <circle id="avPupilR" cx="130" cy="129" r="3" fill="${HAIR}"/>
                        <circle cx="91"  cy="127.5" r=".9" fill="#fff" opacity=".9"/>
                        <circle cx="131" cy="127.5" r=".9" fill="#fff" opacity=".9"/>
                    </g>
                    <rect id="avLidL" x="83" y="115" width="14" height="0" fill="url(#skinM)"/>
                    <rect id="avLidR" x="123" y="115" width="14" height="0" fill="url(#skinM)"/>
                </g>

                <!-- nose -->
                <path d="M110 134 Q107 150 104 154 Q110 158 116 154 Q113 150 110 134 Z"
                      fill="${SKIN_M_DARK}" opacity=".4"/>

                <!-- moustache (subtle) -->
                <path d="M96 162 Q110 158 124 162" stroke="${HAIR}" stroke-width="2" fill="none"/>

                <!-- MOUTH -->
                <g id="avMouthGroup" transform="translate(110 168)">
                    <path id="avMouth"
                          d="M -13 0 Q 0 5 13 0"
                          fill="none" stroke="#3a1f12" stroke-width="3"
                          stroke-linecap="round"/>
                    <path id="avMouthInner"
                          d="M -10 1 Q 0 1 10 1 Q 0 1 -10 1 Z"
                          fill="#3a1f12" opacity="0"/>
                </g>

                <!-- chin shadow -->
                <ellipse cx="110" cy="180" rx="22" ry="4" fill="${SKIN_M_DARK}" opacity=".25"/>
            </g>

            <circle id="listenRing" cx="110" cy="130" r="108" fill="none"
                    stroke="#7bdcb5" stroke-width="3" stroke-dasharray="6 8" opacity="0"/>
        </svg>`;
    }

    // Public API: window.BMUAvatars.svg('male' | 'female') -> string
    window.BMUAvatars = {
        svg(gender) {
            return gender === 'male' ? maleAvatarSVG() : femaleAvatarSVG();
        }
    };
})();
