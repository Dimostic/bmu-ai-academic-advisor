const VOICE_PROFILES = Object.freeze({
    'nigerian-female': { gender: 'female', voice: 'en-NG-EzinneNeural' },
    'nigerian-male': { gender: 'male', voice: 'en-NG-AbeoNeural' },
    'international-female': { gender: 'female', voice: 'en-US-AriaNeural' },
    'international-male': { gender: 'male', voice: 'en-US-GuyNeural' }
});

function normaliseVoiceProfile(value) {
    const profile = String(value || 'avatar').trim().toLowerCase();
    return profile === 'browser' || profile === 'avatar' || Object.prototype.hasOwnProperty.call(VOICE_PROFILES, profile)
        ? profile
        : 'avatar';
}

module.exports = { VOICE_PROFILES, normaliseVoiceProfile };
