import React, { useState, useEffect } from 'react';
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Settings2,
  AlertTriangle
} from '../common/icons';
import { voiceService, type VoiceState, type VoiceConfig } from '../../services/voiceService';
import { useTranslation } from '../../i18n/useTranslation';
import { VoiceSettingsModal } from './VoiceSettingsModal';

export const VoiceControlHeader: React.FC = () => {
  const { t } = useTranslation();
  const [voiceState, setVoiceState] = useState<VoiceState>(voiceService.currentState);
  const [isListening, setIsListening] = useState<boolean>(voiceService.isListening);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [, setIsSpeakingDetected] = useState(false);
  const [, setAudioLevel] = useState(0);
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>(voiceService.getConfig());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  useEffect(() => {
    const unsubState = voiceService.onStateChange((state) => {
      setVoiceState(state);
      setIsListening(voiceService.isListening);
    });

    const unsubLevel = voiceService.onAudioLevel((level, speaking) => {
      setAudioLevel(level);
      setIsSpeakingDetected(speaking);
    });

    return () => {
      unsubState();
      unsubLevel();
    };
  }, []);

  const isHandsFreeActive = isListening;

  const toggleHandsFree = async () => {
    if (isStarting) return;
    setIsStarting(true);
    try {
      await voiceService.toggleHandsFree();
      setIsListening(voiceService.isListening);
      setVoiceState(voiceService.currentState);
    } catch (e) {
      console.error('[VoiceControlHeader] toggle error:', e);
    } finally {
      setIsStarting(false);
    }
  };

  const toggleTts = () => {
    const next = !voiceConfig.ttsEnabled;
    voiceService.saveConfig({ ttsEnabled: next });
    setVoiceConfig((prev) => ({ ...prev, ttsEnabled: next }));
  };

  const isError = voiceState === 'error';

  return (
    <>
      <div className="flex items-center h-full shrink-0 select-none">
        {/* Master Microphone Button (Stable toggle without jumping contents) */}
        <button
          type="button"
          onClick={toggleHandsFree}
          className={`ph-status-item ${isError ? 'ph-status-item-error' : isHandsFreeActive ? 'text-indigo-300' : ''}`}
          title={
            isError
              ? t.voice.micNotFound
              : isHandsFreeActive
              ? t.voice.voiceEnabled
              : t.voice.inactiveTitle
          }
        >
          {isError ? (
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
          ) : isHandsFreeActive ? (
            <Mic className="w-3.5 h-3.5 text-indigo-400" />
          ) : (
            <MicOff className="w-3.5 h-3.5" />
          )}

          <span className="hidden xl:inline">
            {isError ? t.voice.voiceError : isHandsFreeActive ? t.voice.voiceActive : t.voice.voiceOff}
          </span>
        </button>

        {/* TTS Toggle Button */}
        <button
          type="button"
          onClick={toggleTts}
          className={`ph-status-item ${voiceConfig.ttsEnabled ? 'text-indigo-300' : ''}`}
          title={voiceConfig.ttsEnabled ? t.voice.ttsOn : t.voice.ttsOff}
        >
          {voiceConfig.ttsEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
        </button>

        {/* Settings Button */}
        <button
          type="button"
          onClick={() => setIsSettingsOpen(true)}
          className="ph-status-item"
          title={t.voice.settingsTitle}
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Voice Settings Modal */}
      <VoiceSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </>
  );
};
