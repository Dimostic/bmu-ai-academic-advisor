const VOICE_PROFILES = Object.freeze({
    'nigerian-female': { gender: 'female', voice: 'en-NG-EzinneNeural' },
    'nigerian-male': { gender: 'male', voice: 'en-NG-AbeoNeural' },
    'international-female': { gender: 'female', voice: 'en-US-AriaNeural' },
    'international-male': { gender: 'male', voice: 'en-US-GuyNeural' },
    'ttsmaker-nigerian-female': { gender: 'female', provider: 'ttsmaker', voiceId: 2534 },
    'ttsmaker-nigerian-male': { gender: 'male', provider: 'ttsmaker', voiceId: 2533 }
});

function normaliseVoiceProfile(value, { allowTtsmaker = true } = {}) {
    const profile = String(value || 'avatar').trim().toLowerCase();
    if (profile === 'browser' || profile === 'avatar') return profile;
    if (!Object.prototype.hasOwnProperty.call(VOICE_PROFILES, profile)) return 'avatar';
    if (!allowTtsmaker && profile.startsWith('ttsmaker-')) return 'avatar';
    return profile;
}

module.exports = { VOICE_PROFILES, normaliseVoiceProfile };
