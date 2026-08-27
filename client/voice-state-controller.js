/* BMU AI Academic Advisor voice-state controller. */
(function initVoiceStateController(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BMUAdvisorVoiceStateController = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createVoiceStateController() {
    'use strict';

    const DEFAULT_PHASES = [
        'idle',
        'listening',
        'speech-detected',
        'transcribing',
        'thinking',
        'generating-audio',
        'speaking',
        'paused',
        'error'
    ];

    const DEFAULT_ALIASES = {
        talking: 'speaking',
        processing: 'thinking',
        generating: 'generating-audio',
        'generating voice': 'generating-audio',
        'generating audio': 'generating-audio',
        waiting: 'paused',
        ready: 'idle',
        cancelled: 'idle',
        canceled: 'idle'
    };

    class BMUAdvisorVoiceStateController {
        constructor(options = {}) {
            this.phases = new Set(options.phases || DEFAULT_PHASES);
            this.aliases = { ...DEFAULT_ALIASES, ...(options.aliases || {}) };
            this.maxHistory = Math.max(5, Number(options.maxHistory || 30));
            this.phase = this.normalise(options.initialPhase || 'idle');
            this.previousPhase = null;
            this.updatedAt = Date.now();
            this.history = [];
        }

        normalise(stateName, label = '') {
            const raw = String(stateName || 'idle').toLowerCase().trim();
            const text = `${raw} ${label || ''}`.toLowerCase();
            if (/generat.+(audio|voice)|audio.+generat/.test(text)) return 'generating-audio';
            if (this.phases.has(raw)) return raw;
            if (this.aliases[raw]) return this.aliases[raw];
            if (/speech.?detected|voice.?detected|heard/.test(text)) return 'speech-detected';
            if (/transcrib/.test(text)) return 'transcribing';
            if (/listen/.test(text)) return 'listening';
            if (/speak|talk|voice/.test(text)) return 'speaking';
            if (/think|process|prepar/.test(text)) return 'thinking';
            if (/pause|wait/.test(text)) return 'paused';
            if (/error|failed|problem/.test(text)) return 'error';
            return 'idle';
        }

        transition(stateName, label = '', meta = {}) {
            const phase = this.normalise(stateName, label);
            if (this.phase !== phase) {
                const now = Date.now();
                this.previousPhase = this.phase;
                this.history.push({
                    from: this.previousPhase || 'unknown',
                    phase,
                    label: String(label || phase),
                    at: now,
                    previousDurationMs: Math.max(0, now - this.updatedAt),
                    ...meta
                });
                if (this.history.length > this.maxHistory) this.history.shift();
                this.phase = phase;
                this.updatedAt = now;
            }
            return this.snapshot();
        }

        snapshot() {
            return {
                phase: this.phase,
                previousPhase: this.previousPhase,
                updatedAt: this.updatedAt,
                history: this.history.slice()
            };
        }
    }

    BMUAdvisorVoiceStateController.DEFAULT_PHASES = DEFAULT_PHASES.slice();
    BMUAdvisorVoiceStateController.DEFAULT_ALIASES = { ...DEFAULT_ALIASES };
    return BMUAdvisorVoiceStateController;
});
