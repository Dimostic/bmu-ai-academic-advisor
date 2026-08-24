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
    const HAIR_MALE = '#0f0906';
    const HAIR_EDGE = '#0b0705';
    const EYE_WHITE = '#f3e7da';
    const IRIS_F = '#37504c';
    const IRIS_M = '#25322f';
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
                    <stop offset="0%"  stop-color="#7bdcb5" stop-opacity="0.18"/>
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
                        fill="url(#wrapF)" stroke="#2a1632" stroke-width="1.2"/>
                <path d="M58 100 Q90 70 130 75 Q150 80 162 110"
                      fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="2"/>
                <path d="M70 88 Q110 60 150 88" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="3"/>

                <!-- ============= BROWS ============= -->
                <g id="avBrows" stroke="${HAIR_EDGE}" stroke-width="3.5" fill="none" stroke-linecap="round">
                    <path id="avBrowL" d="M82 118 Q92 113 102 118"/>
                    <path id="avBrowR" d="M118 118 Q128 113 138 118"/>
                </g>

                <!-- ============= EYES ============= -->
                <g id="avEyes">
                    <ellipse class="eye-white" cx="92"  cy="130" rx="9" ry="7" fill="${EYE_WHITE}" stroke="#b79d84" stroke-width=".7"/>
                    <ellipse class="eye-white" cx="128" cy="130" rx="9" ry="7" fill="${EYE_WHITE}" stroke="#b79d84" stroke-width=".7"/>
                    <g id="avPupils">
                        <circle id="avIrisL" cx="92"  cy="131" r="5.1" fill="${IRIS_F}" opacity=".96"/>
                        <circle id="avIrisR" cx="128" cy="131" r="5.1" fill="${IRIS_F}" opacity=".96"/>
                        <circle cx="92"  cy="131" r="4.6" fill="${IRIS_F}" opacity=".92"/>
                        <circle cx="128" cy="131" r="4.6" fill="${IRIS_F}" opacity=".92"/>
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

                <!-- ============= MOUTH (path-driven) =============
                     Built from four parts so the lip-sync is genuinely
                     visible: dark cavity at the back, off-white teeth
                     strip in front of it, then upper-lip + lower-lip
                     paths on top. The driver code in advisor.js
                     re-computes all four d= attributes each frame; at
                     rest it forms a closed smile, while speaking the
                     upper lip lifts and the lower lip drops to expose
                     the cavity. -->
                <g id="avMouthGroup" transform="translate(110 167)">
                    <!-- back cavity (visible when mouth is open) -->
                    <path id="avMouthCavity"
                          d="M -16 0 Q 0 0 16 0 Q 0 0 -16 0 Z"
                          fill="#2a0d05"/>
                    <!-- teeth strip in front of the cavity -->
                    <path id="avMouthTeeth"
                          d="M -14 -1 Q 0 -1 14 -1 Q 0 -1 -14 -1 Z"
                          fill="#f7ecd9" opacity="0"/>
                    <!-- upper lip -->
                    <path id="avMouthUpper"
                          d="M -16 0 Q -8 -2 0 -2 Q 8 -2 16 0 Q 8 0 0 0 Q -8 0 -16 0 Z"
                          fill="#7a2f29" stroke="#552220" stroke-width=".6"/>
                    <!-- lower lip -->
                    <path id="avMouthLower"
                          d="M -16 0 Q -8 4 0 4 Q 8 4 16 0 Q 8 0 0 0 Q -8 0 -16 0 Z"
                          fill="#8a3a32" stroke="#552220" stroke-width=".6"/>
                    <!-- legacy id retained so older code paths still find it -->
                    <path id="avMouth" d="M -14 0 Q 0 0 14 0" stroke="none" fill="none"/>
                    <path id="avMouthInner" d="M -10 0 Q 0 0 10 0 Z" fill="none" opacity="0"/>
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

    /** Build the Dr. Tari medical-academic advisor — inspired by the
     *  selected concept: braided hair, academic teal/gold stole and a
     *  subtle stethoscope. Same animation ids as the existing avatars. */
    function medicalAvatarSVG() {
        return `
        <svg id="avatarSvg" viewBox="0 0 220 280" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
                <radialGradient id="bgGlowT" cx="50%" cy="40%" r="60%">
                    <stop offset="0%"  stop-color="#7bdcb5" stop-opacity="0.18"/>
                    <stop offset="100%" stop-color="#0f3d3e" stop-opacity="0"/>
                </radialGradient>
                <linearGradient id="skinT" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#a86f4d"/>
                    <stop offset="100%" stop-color="#7a4a2e"/>
                </linearGradient>
                <linearGradient id="blazerT" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#1b2740"/>
                    <stop offset="100%" stop-color="#111827"/>
                </linearGradient>
                <linearGradient id="stoleT" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#0b6f73"/>
                    <stop offset="100%" stop-color="#074e55"/>
                </linearGradient>
            </defs>

            <circle cx="110" cy="120" r="115" fill="url(#bgGlowT)"/>

            <g id="avTorso">
                <path d="M20 272 Q110 190 200 272 L200 280 L20 280 Z"
                      fill="url(#blazerT)" stroke="#0b1220" stroke-width="1"/>
                <path d="M82 215 L110 258 L138 215 Z" fill="#ffffff"/>
                <path d="M74 224 L93 276 L106 235 L94 218 Z" fill="url(#stoleT)" stroke="#d8b657" stroke-width="1.2"/>
                <path d="M146 224 L127 276 L114 235 L126 218 Z" fill="url(#stoleT)" stroke="#d8b657" stroke-width="1.2"/>
                <path d="M86 246 L100 246 M120 246 L134 246" stroke="#d8b657" stroke-width="2" stroke-linecap="round" opacity=".85"/>
                <path d="M76 226 Q58 238 60 256 Q60 271 74 273" fill="none" stroke="#1f2937" stroke-width="2.4"/>
                <path d="M144 226 Q162 238 160 256 Q160 271 146 273" fill="none" stroke="#1f2937" stroke-width="2.4"/>
                <circle cx="74" cy="273" r="4.5" fill="#d8b657" stroke="#6b5a22"/>
                <circle cx="146" cy="273" r="4.5" fill="#d8b657" stroke="#6b5a22"/>
                <g id="avHandL" transform="translate(50 268) rotate(0)">
                    <ellipse cx="0" cy="0" rx="9" ry="6" fill="url(#skinT)"/>
                </g>
                <g id="avHandR" transform="translate(170 268) rotate(0)">
                    <ellipse cx="0" cy="0" rx="9" ry="6" fill="url(#skinT)"/>
                </g>
            </g>

            <g id="avHead" transform="translate(0 0) rotate(0 110 130)">
                <rect x="94" y="178" width="32" height="28" fill="url(#skinT)"/>
                <path d="M94 200 Q110 210 126 200 L126 210 L94 210 Z" fill="#6b3f27"/>

                <path id="avHair" d="M58 122 Q60 62 108 54 Q157 61 164 122 Q151 91 110 91 Q70 92 58 122 Z"
                      fill="#1b1513" stroke="#0b0705" stroke-width="1.3"/>
                <g stroke="#30231e" stroke-width="3.2" stroke-linecap="round" opacity=".95">
                    <path d="M73 91 Q93 61 121 58"/>
                    <path d="M82 84 Q106 60 137 70"/>
                    <path d="M65 108 Q89 82 125 80"/>
                    <path d="M140 80 Q154 99 154 128"/>
                    <path d="M61 126 Q67 159 82 180"/>
                </g>
                <path id="avHairLine" d="M70 106 Q91 90 110 91 Q132 91 151 106"
                      fill="none" stroke="#080504" stroke-width="2" stroke-opacity=".5"/>

                <ellipse cx="110" cy="130" rx="47" ry="57" fill="url(#skinT)"/>
                <circle cx="62" cy="142" r="4" fill="#e7c64e" stroke="#a98c1c"/>
                <circle cx="158" cy="142" r="4" fill="#e7c64e" stroke="#a98c1c"/>

                <g stroke="#4b2f2a" stroke-width="2.2" fill="none">
                    <rect x="79"  y="121" width="24" height="17" rx="5"/>
                    <rect x="117" y="121" width="24" height="17" rx="5"/>
                    <line x1="103" y1="129" x2="117" y2="129"/>
                </g>

                <g id="avBrows" stroke="#22160f" stroke-width="3.7" fill="none" stroke-linecap="round">
                    <path id="avBrowL" d="M81 118 Q92 113 103 118"/>
                    <path id="avBrowR" d="M117 118 Q128 113 139 118"/>
                </g>

                <g id="avEyes">
                    <ellipse class="eye-white" cx="92"  cy="130" rx="8.5" ry="6.5" fill="${EYE_WHITE}" stroke="#b79d84" stroke-width=".7"/>
                    <ellipse class="eye-white" cx="128" cy="130" rx="8.5" ry="6.5" fill="${EYE_WHITE}" stroke="#b79d84" stroke-width=".7"/>
                    <g id="avPupils">
                        <circle id="avIrisL" cx="92"  cy="131" r="5.1" fill="${IRIS_F}" opacity=".96"/>
                        <circle id="avIrisR" cx="128" cy="131" r="5.1" fill="${IRIS_F}" opacity=".96"/>
                        <circle id="avPupilL" cx="92"  cy="131" r="3.2" fill="${HAIR}"/>
                        <circle id="avPupilR" cx="128" cy="131" r="3.2" fill="${HAIR}"/>
                        <circle cx="93"  cy="129.5" r="1" fill="#fff" opacity=".9"/>
                        <circle cx="129" cy="129.5" r="1" fill="#fff" opacity=".9"/>
                    </g>
                    <rect id="avLidL" x="83" y="115" width="18" height="0" fill="url(#skinT)"/>
                    <rect id="avLidR" x="119" y="115" width="18" height="0" fill="url(#skinT)"/>
                </g>

                <path d="M110 135 Q108 148 105 152 Q110 156 115 152 Q112 148 110 135 Z"
                      fill="#6b3f27" opacity=".35"/>

                <g id="avMouthGroup" transform="translate(110 168)">
                    <path id="avMouthCavity" d="M -16 0 Q 0 0 16 0 Q 0 0 -16 0 Z" fill="#2a0d05"/>
                    <path id="avMouthTeeth" d="M -14 -1 Q 0 -1 14 -1 Q 0 -1 -14 -1 Z" fill="#f7ecd9" opacity="0"/>
                    <path id="avMouthUpper" d="M -16 0 Q -8 -2 0 -2 Q 8 -2 16 0 Q 8 0 0 0 Q -8 0 -16 0 Z"
                          fill="#7a2f29" stroke="#552220" stroke-width=".6"/>
                    <path id="avMouthLower" d="M -16 0 Q -8 4 0 4 Q 8 4 16 0 Q 8 0 0 0 Q -8 0 -16 0 Z"
                          fill="#8a3a32" stroke="#552220" stroke-width=".6"/>
                    <path id="avMouth" d="M -14 0 Q 0 0 14 0" stroke="none" fill="none"/>
                    <path id="avMouthInner" d="M -10 0 Q 0 0 10 0 Z" fill="none" opacity="0"/>
                </g>
            </g>

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
                    <stop offset="0%"  stop-color="#7bdcb5" stop-opacity="0.18"/>
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
                    <path id="avHair" d="M60 112 Q70 58 110 56 Q150 58 160 112 Q152 94 110 92 Q68 94 60 112 Z"
                        fill="${HAIR_MALE}" stroke="${HAIR_EDGE}" stroke-width="1.4"/>
                        <path id="avHairLine" d="M66 100 Q88 84 110 86 Q132 88 154 100"
                        fill="none" stroke="#000" stroke-opacity=".38" stroke-width="2.4"/>

                <!-- glasses frames -->
                <g stroke="${SCRUB}" stroke-width="2.4" fill="none">
                    <rect x="78"  y="120" width="20" height="16" rx="3"/>
                    <rect x="122" y="120" width="20" height="16" rx="3"/>
                    <line x1="98" y1="128" x2="122" y2="128"/>
                </g>

                <!-- BROWS -->
                <g id="avBrows" stroke="${HAIR_MALE}" stroke-width="4.4" fill="none" stroke-linecap="round">
                    <path id="avBrowL" d="M80 116 Q90 112 100 116"/>
                    <path id="avBrowR" d="M120 116 Q130 112 140 116"/>
                </g>

                <!-- EYES -->
                <g id="avEyes">
                    <ellipse class="eye-white" cx="90"  cy="128" rx="7" ry="5.5" fill="${EYE_WHITE}" stroke="#b79d84" stroke-width=".7"/>
                    <ellipse class="eye-white" cx="130" cy="128" rx="7" ry="5.5" fill="${EYE_WHITE}" stroke="#b79d84" stroke-width=".7"/>
                    <g id="avPupils">
                        <circle id="avIrisL" cx="90"  cy="129" r="4.7" fill="${IRIS_M}" opacity=".98"/>
                        <circle id="avIrisR" cx="130" cy="129" r="4.7" fill="${IRIS_M}" opacity=".98"/>
                        <circle cx="90"  cy="129" r="4.1" fill="${IRIS_M}" opacity=".94"/>
                        <circle cx="130" cy="129" r="4.1" fill="${IRIS_M}" opacity=".94"/>
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

                <!-- ============= MOUTH (path-driven) =============
                     Same shape as the female avatar's mouth so the
                     driver code in advisor.js works for both. -->
                <g id="avMouthGroup" transform="translate(110 170)">
                    <path id="avMouthCavity"
                          d="M -15 0 Q 0 0 15 0 Q 0 0 -15 0 Z"
                          fill="#2a0d05"/>
                    <path id="avMouthTeeth"
                          d="M -13 -1 Q 0 -1 13 -1 Q 0 -1 -13 -1 Z"
                          fill="#f7ecd9" opacity="0"/>
                    <path id="avMouthUpper"
                          d="M -15 0 Q -7 -2 0 -2 Q 7 -2 15 0 Q 7 0 0 0 Q -7 0 -15 0 Z"
                          fill="#5a2a1f" stroke="#3a1f12" stroke-width=".6"/>
                    <path id="avMouthLower"
                          d="M -15 0 Q -7 4 0 4 Q 7 4 15 0 Q 7 0 0 0 Q -7 0 -15 0 Z"
                          fill="#6a3225" stroke="#3a1f12" stroke-width=".6"/>
                    <path id="avMouth" d="M -13 0 Q 0 0 13 0" stroke="none" fill="none"/>
                    <path id="avMouthInner" d="M -10 0 Q 0 0 10 0 Z" fill="none" opacity="0"/>
                </g>

                <!-- chin shadow -->
                <ellipse cx="110" cy="180" rx="22" ry="4" fill="${SKIN_M_DARK}" opacity=".25"/>
            </g>

            <circle id="listenRing" cx="110" cy="130" r="108" fill="none"
                    stroke="#7bdcb5" stroke-width="3" stroke-dasharray="6 8" opacity="0"/>
        </svg>`;
    }

    // Public API: window.BMUAvatars.svg('medical' | 'male' | 'female') -> string
    window.BMUAvatars = {
        svg(gender) {
            if (gender === 'medical') return medicalAvatarSVG();
            return gender === 'male' ? maleAvatarSVG() : femaleAvatarSVG();
        },
        /** Compact head-and-shoulders thumbnail used by login/register
         *  picker cards. Same colour palette as the full SVGs but smaller
         *  viewBox so it fits a 110-px-wide circle. */
        thumb(gender) {
            const skin     = gender === 'male' ? SKIN_M      : SKIN_F;
            if (gender === 'male') {
                return `
                <svg viewBox="0 0 110 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <defs>
                        <linearGradient id="thumbBgM" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="#143638"/>
                            <stop offset="100%" stop-color="#0a2528"/>
                        </linearGradient>
                    </defs>
                    <rect x="0" y="0" width="110" height="110" rx="55" fill="url(#thumbBgM)"/>
                    <!-- coat -->
                    <path d="M10 110 Q55 75 100 110 L100 110 Z" fill="${COAT}"/>
                    <path d="M40 95 L55 110 L70 95 Z" fill="${TIE}"/>
                    <!-- neck + head -->
                    <rect x="48" y="68" width="14" height="14" fill="${skin}"/>
                    <ellipse cx="55" cy="52" rx="22" ry="26" fill="${skin}"/>
                    <!-- hair -->
                    <path d="M33 44 Q38 20 55 18 Q72 20 77 44 Q72 33 55 32 Q38 33 33 44 Z" fill="${HAIR}"/>
                    <!-- glasses -->
                    <g stroke="${SCRUB}" stroke-width="1.6" fill="none">
                        <rect x="38" y="48" width="11" height="9" rx="2"/>
                        <rect x="61" y="48" width="11" height="9" rx="2"/>
                        <line x1="49" y1="52" x2="61" y2="52"/>
                    </g>
                    <!-- eyes -->
                    <g id="thumbEyes">
                        <circle id="thumbEyeFlashL" class="thumb-eye-flash" cx="44" cy="53" r="4.8" fill="#7bdcb5" fill-opacity=".12" stroke="#cffff0" stroke-width="1.45" opacity="0"/>
                        <circle id="thumbEyeFlashR" class="thumb-eye-flash" cx="66" cy="53" r="4.8" fill="#7bdcb5" fill-opacity=".12" stroke="#cffff0" stroke-width="1.45" opacity="0"/>
                        <circle cx="44" cy="53" r="1.5" fill="${HAIR}"/>
                        <circle cx="66" cy="53" r="1.5" fill="${HAIR}"/>
                    </g>
                    <!-- mouth (smile) -->
                    <path id="thumbMouth" d="M46 64 Q55 68 64 64" fill="none" stroke="#3a1f12" stroke-width="1.6" stroke-linecap="round"/>
                </svg>`;
            }
            if (gender === 'medical') {
                return `
                <svg viewBox="0 0 110 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <defs>
                        <linearGradient id="thumbBgT" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="#12393f"/>
                            <stop offset="100%" stop-color="#0a2528"/>
                        </linearGradient>
                    </defs>
                    <rect x="0" y="0" width="110" height="110" rx="55" fill="url(#thumbBgT)"/>
                    <path d="M10 110 Q55 76 100 110 L100 110 Z" fill="#1b2740"/>
                    <path d="M39 94 L50 110 L55 92 L48 83 Z" fill="#0b6f73" stroke="#d8b657" stroke-width=".8"/>
                    <path d="M71 94 L60 110 L55 92 L62 83 Z" fill="#0b6f73" stroke="#d8b657" stroke-width=".8"/>
                    <rect x="48" y="69" width="14" height="14" fill="${SKIN_F}"/>
                    <path d="M31 48 Q35 19 55 15 Q77 18 80 48 Q72 31 55 31 Q38 31 31 48 Z" fill="#1b1513"/>
                    <g stroke="#30231e" stroke-width="2" stroke-linecap="round">
                        <path d="M37 41 Q48 21 64 18"/>
                        <path d="M45 35 Q59 20 73 29"/>
                        <path d="M32 55 Q42 72 47 80"/>
                    </g>
                    <ellipse cx="55" cy="53" rx="22" ry="26" fill="${SKIN_F}"/>
                    <g stroke="#4b2f2a" stroke-width="1.4" fill="none">
                        <rect x="38" y="49" width="12" height="9" rx="2"/>
                        <rect x="60" y="49" width="12" height="9" rx="2"/>
                        <line x1="50" y1="53" x2="60" y2="53"/>
                    </g>
                    <g id="thumbEyes">
                        <circle id="thumbEyeFlashL" class="thumb-eye-flash" cx="45" cy="54" r="5" fill="#7bdcb5" fill-opacity=".12" stroke="#cffff0" stroke-width="1.55" opacity="0"/>
                        <circle id="thumbEyeFlashR" class="thumb-eye-flash" cx="65" cy="54" r="5" fill="#7bdcb5" fill-opacity=".12" stroke="#cffff0" stroke-width="1.55" opacity="0"/>
                        <circle cx="45" cy="54" r="1.7" fill="${HAIR}"/>
                        <circle cx="65" cy="54" r="1.7" fill="${HAIR}"/>
                    </g>
                    <path id="thumbMouth" d="M46 65 Q55 69 64 65" fill="none" stroke="#552220" stroke-width="1.8" stroke-linecap="round"/>
                    <path d="M33 84 Q28 96 39 100 M77 84 Q82 96 71 100" fill="none" stroke="#1f2937" stroke-width="1.5"/>
                </svg>`;
            }
            return `
                <svg viewBox="0 0 110 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <defs>
                        <linearGradient id="thumbBgF" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="#143638"/>
                            <stop offset="100%" stop-color="#0a2528"/>
                        </linearGradient>
                        <linearGradient id="thumbWrapF" x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0%" stop-color="#3a1c4a"/>
                            <stop offset="50%" stop-color="#7b2e58"/>
                            <stop offset="100%" stop-color="#c64a73"/>
                        </linearGradient>
                    </defs>
                    <rect x="0" y="0" width="110" height="110" rx="55" fill="url(#thumbBgF)"/>
                    <!-- coat -->
                    <path d="M10 110 Q55 75 100 110 L100 110 Z" fill="${COAT}"/>
                    <path d="M40 95 L55 110 L70 95 Z" fill="${TIE}"/>
                    <!-- neck + head -->
                    <rect x="48" y="68" width="14" height="14" fill="${skin}"/>
                    <ellipse cx="55" cy="52" rx="22" ry="26" fill="${skin}"/>
                    <!-- gele wrap -->
                    <path d="M29 44 Q38 14 55 12 Q72 14 81 44 Q76 30 55 30 Q34 30 29 44 Z"
                          fill="url(#thumbWrapF)"/>
                    <!-- earrings -->
                    <circle cx="33" cy="58" r="2" fill="#e7c64e" stroke="#a98c1c"/>
                    <circle cx="77" cy="58" r="2" fill="#e7c64e" stroke="#a98c1c"/>
                    <!-- eyes -->
                    <g id="thumbEyes">
                        <circle id="thumbEyeFlashL" class="thumb-eye-flash" cx="46" cy="54" r="5" fill="#7bdcb5" fill-opacity=".12" stroke="#cffff0" stroke-width="1.55" opacity="0"/>
                        <circle id="thumbEyeFlashR" class="thumb-eye-flash" cx="64" cy="54" r="5" fill="#7bdcb5" fill-opacity=".12" stroke="#cffff0" stroke-width="1.55" opacity="0"/>
                        <circle cx="46" cy="54" r="1.7" fill="${HAIR}"/>
                        <circle cx="64" cy="54" r="1.7" fill="${HAIR}"/>
                    </g>
                    <!-- mouth (smile) -->
                    <path id="thumbMouth" d="M46 64 Q55 69 64 64" fill="none" stroke="#552220" stroke-width="1.8" stroke-linecap="round"/>
                </svg>`;
        }
    };
})();
