#!/usr/bin/env node

const assert = require('assert');
const { VOICE_PROFILES, normaliseVoiceProfile } = require('../services/ttsVoiceProfiles');

const expected = {
    'nigerian-female': { gender: 'female', voice: 'en-NG-EzinneNeural' },
    'nigerian-male': { gender: 'male', voice: 'en-NG-AbeoNeural' },
    'international-female': { gender: 'female', voice: 'en-US-AriaNeural' },
    'international-male': { gender: 'male', voice: 'en-US-GuyNeural' },
    'ttsmaker-nigerian-female': { gender: 'female', provider: 'ttsmaker', voiceId: 2534 },
    'ttsmaker-nigerian-male': { gender: 'male', provider: 'ttsmaker', voiceId: 2533 }
};

assert.deepStrictEqual(VOICE_PROFILES, expected);
assert.strictEqual(normaliseVoiceProfile('avatar'), 'avatar');
assert.strictEqual(normaliseVoiceProfile('browser'), 'browser');
for (const profile of Object.keys(expected)) {
    assert.strictEqual(normaliseVoiceProfile(profile), profile);
}
for (const profile of ['ttsmaker-nigerian-female', 'ttsmaker-nigerian-male']) {
    assert.strictEqual(normaliseVoiceProfile(profile, { allowTtsmaker: false }), 'avatar');
}
assert.strictEqual(normaliseVoiceProfile('https://untrusted.example/voice'), 'avatar');
assert.strictEqual(normaliseVoiceProfile('unknown'), 'avatar');

console.log(JSON.stringify({
    success: true,
    checked: 'Allowlisted Nigerian/international neural voice profiles and safe fallback'
}));
