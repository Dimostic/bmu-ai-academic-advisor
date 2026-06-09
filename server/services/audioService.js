const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const speechsdk = require('microsoft-cognitiveservices-speech-sdk');

class AudioService {
    constructor() {
        this.apiKey = process.env.OPENROUTER_API_KEY;
        this.baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
        this.ttsProvider = process.env.TTS_PROVIDER || (process.platform === 'darwin' ? 'macos' : 'none');
        this.language = process.env.TTS_LANGUAGE || 'en';
        this.audioDir = path.join(__dirname, '../../uploads/audio');
    }

    // Convert speech to text (STT)
    async speechToText(audioFilePath) {
        try {
            // Use multipart form-data compatible with OpenAI-style transcription endpoints.
            // OpenRouter aims to be OpenAI-compatible, but exact behavior can vary by provider.
            const form = new (require('form-data'))();
            form.append('file', require('fs').createReadStream(audioFilePath));
            form.append('model', 'openai/whisper-1');
            form.append('language', this.language || 'en');

            const response = await axios.post(
                `${this.baseUrl}/audio/transcriptions`,
                form,
                {
                    headers: {
                        ...form.getHeaders(),
                        'Authorization': `Bearer ${this.apiKey}`,
                        'HTTP-Referer': 'https://bmu.edu.ng',
                        'X-Title': 'BMU AI Assistant'
                    },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                }
            );

            return {
                success: true,
                text: response.data.text,
                language: response.data.language || this.language || 'en'
            };
        } catch (error) {
            console.error('Speech to text error:', error.response?.data || error.message);
            return {
                success: false,
                text: '',
                error: error.response?.data?.error || error.message
            };
        }
    }

    // Convert text to speech (TTS)
    async textToSpeech(text, options = {}) {
        try {
            const cleaned = String(text || '').trim();
            if (!cleaned) {
                return { success: false, audioUrl: null, error: 'No text provided for TTS' };
            }

            // Ensure directory exists
            await fs.mkdir(this.audioDir, { recursive: true });

            // Prefer cloud TTS (Azure Speech) for Nigerian-accent voice.
            if (this.ttsProvider === 'azure') {
                const key = process.env.AZURE_SPEECH_KEY;
                const region = process.env.AZURE_SPEECH_REGION;
                if (!key || !region) {
                    return { success: false, audioUrl: null, error: 'Azure TTS not configured (AZURE_SPEECH_KEY/AZURE_SPEECH_REGION)' };
                }

                const filename = `${uuidv4()}.wav`;
                const filePath = path.join(this.audioDir, filename);

                const speechConfig = speechsdk.SpeechConfig.fromSubscription(key, region);
                // Nigerian English voices (examples): en-NG-EzinneNeural, en-NG-AbeoNeural
                // Allow override.
                speechConfig.speechSynthesisVoiceName = options.voice
                    || process.env.AZURE_TTS_VOICE
                    || 'en-NG-EzinneNeural';

                // Output to WAV file
                const audioConfig = speechsdk.AudioConfig.fromAudioFileOutput(filePath);
                const synthesizer = new speechsdk.SpeechSynthesizer(speechConfig, audioConfig);

                const ssml = options.ssml || this._toSsml(cleaned, speechConfig.speechSynthesisVoiceName);

                await new Promise((resolve, reject) => {
                    synthesizer.speakSsmlAsync(
                        ssml,
                        (result) => {
                            synthesizer.close();
                            if (result.reason === speechsdk.ResultReason.SynthesizingAudioCompleted) {
                                resolve();
                            } else {
                                reject(new Error(result.errorDetails || 'Azure TTS failed'));
                            }
                        },
                        (err) => {
                            synthesizer.close();
                            reject(err);
                        }
                    );
                });

                return { success: true, audioUrl: `/api/chat/audio/${filename}`, filePath };
            }

            // DEV fallback: macOS say
            if (this.ttsProvider === 'macos') {
                const filename = `${uuidv4()}.aiff`;
                const filePath = path.join(this.audioDir, filename);
                const voice = options.voice || process.env.MACOS_TTS_VOICE || 'Samantha';
                const rate = Number(options.rate || process.env.MACOS_TTS_RATE || 180);

                await new Promise((resolve, reject) => {
                    execFile('say', ['-v', voice, '-r', String(rate), '-o', filePath, cleaned], (err) => {
                        if (err) return reject(err);
                        resolve();
                    });
                });

                return { success: true, audioUrl: `/api/chat/audio/${filename}`, filePath };
            }

            return {
                success: false,
                audioUrl: null,
                error: 'TTS provider not configured. Set TTS_PROVIDER=azure (prod) or TTS_PROVIDER=macos (dev).'
            };

        } catch (error) {
            console.error('Text to speech error:', error.message);
            return {
                success: false,
                audioUrl: null,
                error: error.message
            };
        }
    }

    // Process voice message and generate AI response
    async processVoiceMessage(audioFilePath, sessionContext = {}) {
        try {
            // Step 1: Convert speech to text
            const sttResult = await this.speechToText(audioFilePath);
            
            if (!sttResult.success) {
                return {
                    success: false,
                    error: 'Failed to transcribe audio',
                    originalError: sttResult.error
                };
            }

            const userText = sttResult.text;

            // Step 2: Generate AI response (will be done by chat service)
            // This returns the transcribed text for the chat service to process
            return {
                success: true,
                transcribedText: userText,
                language: sttResult.language
            };

        } catch (error) {
            console.error('Voice processing error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Generate audio response from AI text
    async generateAudioResponse(responseText, options = {}) {
        try {
            // Clean text for TTS (remove markdown, etc.)
            const cleanedText = this.cleanTextForTTS(responseText);
            
            // Generate TTS audio
            const ttsResult = await this.textToSpeech(cleanedText, options);
            
            return ttsResult;

        } catch (error) {
            console.error('Audio response generation error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Clean text for TTS (remove markdown, special characters, etc.)
    cleanTextForTTS(text) {
        return text
            .replace(/\*\*(.*?)\*\*/g, '$1')    // Remove bold markdown
            .replace(/\*(.*?)\*/g, '$1')         // Remove italic markdown
            .replace(/#{1,6}\s/g, '')            // Remove headers
            .replace(/```[\s\S]*?```/g, '')      // Remove code blocks
            .replace(/`(.*?)`/g, '$1')           // Remove inline code
            .replace(/\[(.*?)\]\(.*?\)/g, '$1')  // Remove links, keep text
            .replace(/[-*+]\s/g, '')             // Remove list markers
            .replace(/\n{2,}/g, '. ')            // Replace multiple newlines with period
            .replace(/\n/g, ' ')                 // Replace single newlines with space
            .replace(/\s{2,}/g, ' ')             // Remove extra spaces
            .trim();
    }

    _toSsml(text, voiceName) {
        // Basic SSML wrapper. Kept minimal to avoid provider-specific issues.
        const escaped = String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');

        return `<?xml version="1.0" encoding="utf-8"?>
<speak version="1.0" xml:lang="en-NG" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts">
  <voice name="${voiceName}">
    ${escaped}
  </voice>
</speak>`;
    }

    // Delete audio file
    async deleteAudioFile(filename) {
        try {
            const filePath = path.join(this.audioDir, filename);
            await fs.unlink(filePath);
            return true;
        } catch (error) {
            console.error('Audio file deletion error:', error.message);
            return false;
        }
    }

    // Clean old audio files (for maintenance)
    async cleanOldAudioFiles(maxAgeHours = 24) {
        try {
            const files = await fs.readdir(this.audioDir);
            const now = Date.now();
            const maxAge = maxAgeHours * 60 * 60 * 1000;
            let deletedCount = 0;

            for (const file of files) {
                const filePath = path.join(this.audioDir, file);
                const stats = await fs.stat(filePath);
                
                if (now - stats.mtimeMs > maxAge) {
                    await fs.unlink(filePath);
                    deletedCount++;
                }
            }

            return { deletedCount };
        } catch (error) {
            console.error('Audio cleanup error:', error.message);
            return { deletedCount: 0, error: error.message };
        }
    }
}

module.exports = new AudioService();
