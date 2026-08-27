#!/usr/bin/env node

const VoiceStateController = require('../../client/voice-state-controller');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function main() {
    const controller = new VoiceStateController();
    assert(controller.snapshot().phase === 'idle', 'Expected initial phase to be idle');
    assert(controller.normalise('talking') === 'speaking', 'Expected talking alias to map to speaking');
    assert(controller.normalise('thinking', 'Generating voice') === 'generating-audio', 'Expected generating voice label to map to generating-audio');
    assert(controller.normalise('heard words') === 'speech-detected', 'Expected heard words to map to speech-detected');

    controller.transition('listening', 'Listening');
    controller.transition('speech-detected', 'Speech detected');
    controller.transition('transcribing', 'Transcribing');
    controller.transition('generating', 'Generating voice');
    controller.transition('talking', 'Speaking');

    const snapshot = controller.snapshot();
    assert(snapshot.phase === 'speaking', `Expected final phase speaking, got ${snapshot.phase}`);
    assert(snapshot.history.length === 5, `Expected five transitions, got ${snapshot.history.length}`);
    assert(snapshot.history.some(item => item.phase === 'generating-audio'), 'Expected generating-audio transition in history');

    console.log(JSON.stringify({
        success: true,
        checked: 'Formal advisor voice-state controller'
    }, null, 2));
}

try {
    main();
    process.exit(0);
} catch (error) {
    console.error(error.message || error);
    process.exit(1);
}
