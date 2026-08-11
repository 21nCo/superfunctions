//
//  WhisperCppWrapper.mm
//  DictationPOC
//

#import "WhisperCppWrapper.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#if __has_include(<whisper/whisper.h>)
#include <whisper/whisper.h>
#define DICTATIONPOC_HAS_WHISPER 1
#elif __has_include(<whisper.h>)
#include <whisper.h>
#define DICTATIONPOC_HAS_WHISPER 1
#elif __has_include("whisper.h")
#include "whisper.h"
#define DICTATIONPOC_HAS_WHISPER 1
#else
#define DICTATIONPOC_HAS_WHISPER 0
struct whisper_context;
struct whisper_context_params {
    bool use_gpu;
    bool flash_attn;
};
struct whisper_full_params {
    bool print_realtime;
    bool print_progress;
    bool print_timestamps;
    bool translate;
    const char * language;
    int n_threads;
    int offset_ms;
    bool print_special;
    bool no_context;
    bool single_segment;
    bool token_timestamps;
};
#endif

@implementation WhisperCppWrapper {
    struct whisper_context * ctx;
    BOOL isUsingCoreML;
}

- (instancetype)initWithModelPath:(NSString *)modelPath {
    return [self initWithModelPath:modelPath coreMLModelPath:nil];
}

- (instancetype)initWithModelPath:(NSString *)modelPath coreMLModelPath:(nullable NSString *)coreMLModelPath {
    self = [super init];
    if (self) {
        isUsingCoreML = NO;
        ctx = nullptr;

#if DICTATIONPOC_HAS_WHISPER
        whisper_context_params cparams = whisper_context_default_params();

        if (coreMLModelPath.length > 0 && [[NSFileManager defaultManager] fileExistsAtPath:coreMLModelPath]) {
            isUsingCoreML = YES;
        }

        ctx = whisper_init_from_file_with_params([modelPath UTF8String], cparams);
        if (ctx == nullptr) {
            ctx = whisper_init_from_file([modelPath UTF8String]);
        }
        if (ctx == nullptr) {
            NSLog(@"Failed to initialize whisper context with model: %@", modelPath);
            return nil;
        }
#else
        NSLog(@"whisper.xcframework / whisper headers not found. Add the framework before using local transcription.");
        return nil;
#endif

        (void)coreMLModelPath;
    }
    return self;
}

- (void)dealloc {
#if DICTATIONPOC_HAS_WHISPER
    if (ctx) {
        whisper_free(ctx);
        ctx = nullptr;
    }
#endif
}

- (NSString *)transcribeAudioAtPath:(NSString *)audioPath error:(NSError **)error {
    return [self transcribeAudioAtPath:audioPath
                              language:nil
                    enableDiarization:NO
                      enableTimestamps:NO
                 enableImprovedFormat:NO
                                error:error];
}

- (NSString *)transcribeAudioAtPath:(NSString *)audioPath
                           language:(nullable NSString *)language
                 enableDiarization:(BOOL)enableDiarization
                   enableTimestamps:(BOOL)enableTimestamps
              enableImprovedFormat:(BOOL)enableImprovedFormat
                             error:(NSError **)error {
#if DICTATIONPOC_HAS_WHISPER
    if (!ctx) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey: @"Whisper context not initialized"}];
        }
        return nil;
    }

    NSData *audioData = [NSData dataWithContentsOfFile:audioPath];
    if (!audioData) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:2
                                     userInfo:@{NSLocalizedDescriptionKey: @"Failed to load audio file"}];
        }
        return nil;
    }

    if (audioData.length < 44) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:3
                                     userInfo:@{NSLocalizedDescriptionKey: @"Invalid WAV file"}];
        }
        return nil;
    }

    const uint8_t *bytes = (const uint8_t *)[audioData bytes];
    const size_t audioLength = (size_t)audioData.length;
    if (std::memcmp(bytes, "RIFF", 4) != 0 || std::memcmp(bytes + 8, "WAVE", 4) != 0) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:4
                                     userInfo:@{NSLocalizedDescriptionKey: @"Invalid WAV file: not RIFF/WAVE format"}];
        }
        return nil;
    }

    const auto readLE16 = [bytes](size_t offset) -> uint16_t {
        return (uint16_t)bytes[offset] | ((uint16_t)bytes[offset + 1] << 8);
    };
    const auto readLE32 = [bytes](size_t offset) -> uint32_t {
        return (uint32_t)bytes[offset] |
            ((uint32_t)bytes[offset + 1] << 8) |
            ((uint32_t)bytes[offset + 2] << 16) |
            ((uint32_t)bytes[offset + 3] << 24);
    };

    bool foundFormat = false;
    uint16_t audioFormat = 0;
    uint16_t numChannels = 0;
    uint16_t blockAlign = 0;
    uint16_t bitsPerSample = 0;
    uint32_t sampleRateValue = 0;
    size_t dataPos = 0;
    size_t dataSize = 0;

    for (size_t chunkPos = 12; chunkPos + 8 <= audioLength;) {
        const uint32_t chunkSize = readLE32(chunkPos + 4);
        const size_t chunkDataPos = chunkPos + 8;
        if ((size_t)chunkSize > audioLength - chunkDataPos) {
            if (error) {
                *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                             code:5
                                         userInfo:@{NSLocalizedDescriptionKey: @"Invalid WAV file: chunk exceeds file bounds"}];
            }
            return nil;
        }

        if (std::memcmp(bytes + chunkPos, "fmt ", 4) == 0) {
            if (chunkSize < 16) {
                if (error) {
                    *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                                 code:5
                                             userInfo:@{NSLocalizedDescriptionKey: @"Invalid WAV file: truncated fmt chunk"}];
                }
                return nil;
            }
            audioFormat = readLE16(chunkDataPos);
            numChannels = readLE16(chunkDataPos + 2);
            sampleRateValue = readLE32(chunkDataPos + 4);
            blockAlign = readLE16(chunkDataPos + 12);
            bitsPerSample = readLE16(chunkDataPos + 14);
            foundFormat = true;
        } else if (std::memcmp(bytes + chunkPos, "data", 4) == 0 && dataPos == 0) {
            dataPos = chunkDataPos;
            dataSize = (size_t)chunkSize;
        }

        chunkPos = chunkDataPos + (size_t)chunkSize + (chunkSize & 1U);
    }

    if (!foundFormat) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:5
                                     userInfo:@{NSLocalizedDescriptionKey: @"Invalid WAV file: no fmt chunk"}];
        }
        return nil;
    }

    if (dataPos == 0) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:6
                                     userInfo:@{NSLocalizedDescriptionKey: @"Invalid WAV file: no data chunk"}];
        }
        return nil;
    }

    const size_t bytesPerSample = bitsPerSample / 8;
    const size_t expectedBlockAlign = bytesPerSample * (size_t)numChannels;
    if (audioFormat != 1 || numChannels == 0 || sampleRateValue == 0 ||
        sampleRateValue > (uint32_t)std::numeric_limits<int>::max() ||
        bitsPerSample != 16 || blockAlign == 0 || blockAlign != expectedBlockAlign ||
        dataSize == 0 || dataSize % blockAlign != 0 || dataSize > audioLength - dataPos) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:7
                                     userInfo:@{NSLocalizedDescriptionKey: @"Invalid or unsupported WAV format"}];
        }
        return nil;
    }

    const size_t sampleFrameCount = dataSize / blockAlign;
    if (sampleFrameCount > (size_t)std::numeric_limits<int>::max()) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:7
                                     userInfo:@{NSLocalizedDescriptionKey: @"WAV file contains too many samples"}];
        }
        return nil;
    }

    const int nSamples = (int)sampleFrameCount;
    const int sampleRate = (int)sampleRateValue;
    std::vector<float> pcmf32;
    pcmf32.resize(nSamples);

    for (int i = 0; i < nSamples; i++) {
        float sum = 0.0f;
        for (uint16_t channel = 0; channel < numChannels; channel++) {
            const size_t sampleOffset =
                dataPos + ((size_t)i * numChannels + channel) * bytesPerSample;
            const int16_t sample = (int16_t)readLE16(sampleOffset);
            sum += sample / 32768.0f;
        }
        pcmf32[i] = sum / numChannels;
    }

    return [self transcribeAudioFromPCMData:pcmf32.data()
                                sampleCount:(int)pcmf32.size()
                                 sampleRate:sampleRate
                                   language:language
                         enableDiarization:enableDiarization
                           enableTimestamps:enableTimestamps
                      enableImprovedFormat:enableImprovedFormat
                                     error:error];
#else
    if (error) {
        *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                     code:100
                                 userInfo:@{NSLocalizedDescriptionKey: @"whisper.xcframework is not linked into the project"}];
    }
    (void)audioPath;
    (void)language;
    (void)enableDiarization;
    (void)enableTimestamps;
    (void)enableImprovedFormat;
    return nil;
#endif
}

- (NSString *)transcribeAudioFromPCMData:(const float *)pcmData
                              sampleCount:(int)sampleCount
                               sampleRate:(int)sampleRate
                                    error:(NSError **)error {
    return [self transcribeAudioFromPCMData:pcmData
                                sampleCount:sampleCount
                                 sampleRate:sampleRate
                                   language:nil
                         enableDiarization:NO
                           enableTimestamps:NO
                      enableImprovedFormat:NO
                                     error:error];
}

- (NSString *)transcribeAudioFromPCMData:(const float *)pcmData
                              sampleCount:(int)sampleCount
                               sampleRate:(int)sampleRate
                                 language:(nullable NSString *)language
                       enableDiarization:(BOOL)enableDiarization
                         enableTimestamps:(BOOL)enableTimestamps
                    enableImprovedFormat:(BOOL)enableImprovedFormat
                                   error:(NSError **)error {
#if DICTATIONPOC_HAS_WHISPER
    if (!ctx) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey: @"Whisper context not initialized"}];
        }
        return nil;
    }

    if (!pcmData || sampleCount <= 0) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:2
                                     userInfo:@{NSLocalizedDescriptionKey: @"Invalid PCM data or sample count"}];
        }
        return nil;
    }

    if (sampleRate <= 0) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:4
                                     userInfo:@{NSLocalizedDescriptionKey: @"Sample rate must be greater than zero"}];
        }
        return nil;
    }

    std::vector<float> pcmf32;

    if (sampleRate == 16000) {
        pcmf32.assign(pcmData, pcmData + sampleCount);
    } else {
        const double ratio = 16000.0 / sampleRate;
        const double targetSampleCount = sampleCount * ratio;
        if (!std::isfinite(targetSampleCount) || targetSampleCount < 1.0 ||
            targetSampleCount > std::numeric_limits<int>::max()) {
            if (error) {
                *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                             code:4
                                         userInfo:@{NSLocalizedDescriptionKey: @"Sample rate produces an invalid resampled buffer size"}];
            }
            return nil;
        }
        const int targetSamples = (int)targetSampleCount;
        pcmf32.resize(targetSamples);

        for (int i = 0; i < targetSamples; i++) {
            const double srcIndex = i / ratio;
            const int srcI = (int)srcIndex;
            const double frac = srcIndex - srcI;

            if (srcI + 1 < sampleCount) {
                pcmf32[i] = pcmData[srcI] * (1.0 - frac) + pcmData[srcI + 1] * frac;
            } else {
                pcmf32[i] = pcmData[std::min(srcI, sampleCount - 1)];
            }
        }
    }

    const int requiredSamples = 1600;
    if ((int)pcmf32.size() < requiredSamples) {
        std::vector<float> padded(requiredSamples, 0.0f);
        std::copy(pcmf32.begin(), pcmf32.end(), padded.begin());
        pcmf32 = std::move(padded);
    }

    whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    wparams.print_realtime = false;
    wparams.print_progress = false;
    wparams.print_timestamps = enableTimestamps;
    wparams.translate = false;
    wparams.language = language ? [language UTF8String] : "en";
    wparams.n_threads = std::min(8, (int)std::thread::hardware_concurrency());
    wparams.offset_ms = 0;
    wparams.no_timestamps = !enableTimestamps;
    wparams.no_context = true;
    wparams.single_segment = true;
    wparams.suppress_blank = true;
    wparams.suppress_nst = true;
    wparams.max_tokens = 96;
    wparams.no_speech_thold = 0.65f;
    wparams.logprob_thold = -1.0f;
    wparams.entropy_thold = 2.4f;
    wparams.temperature = 0.0f;
    wparams.temperature_inc = 0.0f;

    if (enableImprovedFormat) {
        wparams.print_special = false;
    }

    if (enableDiarization) {
        wparams.print_timestamps = true;
        wparams.token_timestamps = true;
    }

    if (whisper_full(ctx, wparams, pcmf32.data(), (int)pcmf32.size()) != 0) {
        if (error) {
            *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                         code:3
                                     userInfo:@{NSLocalizedDescriptionKey: @"Failed to process audio with whisper"}];
        }
        return nil;
    }

    NSMutableString *transcription = [NSMutableString string];
    const int nSegments = whisper_full_n_segments(ctx);

    if (enableTimestamps) {
        for (int i = 0; i < nSegments; ++i) {
            const int64_t t0 = whisper_full_get_segment_t0(ctx, i);
            const int64_t t1 = whisper_full_get_segment_t1(ctx, i);
            const char *segmentText = whisper_full_get_segment_text(ctx, i);

            [transcription appendFormat:@"[%.2f - %.2f] %s ", t0 / 100.0, t1 / 100.0, segmentText];
        }
    } else {
        for (int i = 0; i < nSegments; ++i) {
            const char *segmentText = whisper_full_get_segment_text(ctx, i);
            [transcription appendFormat:@"%s ", segmentText];
        }
    }

    return [transcription stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
#else
    if (error) {
        *error = [NSError errorWithDomain:@"WhisperCppWrapper"
                                     code:100
                                 userInfo:@{NSLocalizedDescriptionKey: @"whisper.xcframework is not linked into the project"}];
    }
    (void)pcmData;
    (void)sampleCount;
    (void)sampleRate;
    (void)language;
    (void)enableDiarization;
    (void)enableTimestamps;
    (void)enableImprovedFormat;
    return nil;
#endif
}

- (BOOL)isUsingCoreML {
    return isUsingCoreML;
}

+ (NSString *)version {
#if DICTATIONPOC_HAS_WHISPER
    return [NSString stringWithUTF8String:whisper_print_system_info()];
#else
    return @"whisper.cpp unavailable";
#endif
}

@end
