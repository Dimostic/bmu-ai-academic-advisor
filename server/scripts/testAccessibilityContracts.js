#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertButtonAccessible(html, id) {
    const match = html.match(new RegExp(`<button[^>]+id=["']${id}["'][\\s\\S]*?>`, 'i'));
    assert(match, `Expected #${id} button`);
    const tag = match[0];
    assert(/\baria-label=|\btitle=|>[^<]*\S/.test(tag), `Expected #${id} to have an accessible name via aria-label, title, or text`);
}

function main() {
    const advisorHtml = read('client/advisor.html');
    const adminHtml = read('client/admin.html');
    const advisorCss = read('client/advisor.css');
    const pagesCss = read('client/pages.css');

    assert(/<html\s+lang=["']en["']/i.test(advisorHtml), 'Advisor page must declare lang=en');
    assert(/<meta\s+name=["']viewport["'][^>]+width=device-width/i.test(advisorHtml), 'Advisor page must use responsive viewport meta');
    assert(/id=["']avatarStatus["'][^>]+role=["']status["'][^>]+aria-live=["']polite["']/i.test(advisorHtml), 'Avatar status must be an aria-live status region');
    assert(/id=["']transcript["'][^>]+aria-live=["']polite["']/i.test(advisorHtml), 'Transcript must be aria-live');
    assert(/voice-state-controller\.js/.test(advisorHtml), 'Advisor page must load the voice-state controller before advisor.js');

    [
        'topMenuToggleBtn',
        'advisorViewToggleBtn',
        'hardRefreshBtn',
        'themeToggleBtn',
        'historyToggleBtn',
        'avatarMicBtn',
        'avatarAudioSettingsBtn',
        'avatarMuteBtn',
        'avatarPauseBtn',
        'avatarHardRefreshBtn',
        'avatarGenderToggleBtn',
        'micBtn',
        'clearInputBtn',
        'sendBtn',
        'audioSettingsCloseBtn'
    ].forEach(id => assertButtonAccessible(advisorHtml, id));

    assert(/<html\s+lang=["']en["']/i.test(adminHtml), 'Admin page must declare lang=en');
    assert(/aria-label=["']Admin sections["']/i.test(adminHtml), 'Admin navigation must have an accessible label');
    assert(!/letter-spacing\s*:\s*-[\d.]/i.test(advisorCss + '\n' + pagesCss), 'CSS must not use negative letter-spacing');

    console.log(JSON.stringify({
        success: true,
        checked: 'Advisor/admin accessibility contract baseline'
    }, null, 2));
}

try {
    main();
    process.exit(0);
} catch (error) {
    console.error(error.message || error);
    process.exit(1);
}
