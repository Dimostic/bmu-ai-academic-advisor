#!/usr/bin/env node

const assert = require('assert');
const tts = require('../services/ttsService');

const expected = {
    'nigerian-female': { gender: 'female', voice: 'en-NG-EzinneNeural' },
    'nigerian-male': { gender: 'male', voice: 'en-NG-AbeoNeural' },
    'international-female': { gender: 'female', voice: 'en-US-AriaNeural' },
    'international-male': { gender: 'male', voice: 'en-US-GuyNeural' }
};

assert.deepStrictEqual(tts.VOICE_PROFILES, expected);
assert.strictEqual(tts.normaliseVoiceProfile('avatar'), 'avatar');
assert.strictEqual(tts.normaliseVoiceProfile('browser'), 'browser');
for (const profile of Object.keys(expected)) {
    assert.strictEqual(tts.normaliseVoiceProfile(profile), profile);
}
assert.strictEqual(tts.normaliseVoiceProfile('https://untrusted.example/voice'), 'avatar');
assert.strictEqual(tts.normaliseVoiceProfile('unknown'), 'avatar');

console.log(JSON.stringify({
    success: true,
    checked: 'Allowlisted Nigerian/international neural voice profiles and safe fallback'
}));
