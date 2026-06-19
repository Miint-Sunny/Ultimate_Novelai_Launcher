import React, { useCallback, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, Check, Copy, Download } from 'lucide-react';
import { mobileWeightConvert } from './weightConvert';
import type { MobileProcessFileForTarget } from './types';

interface MobileWeightToolSectionProps {
  processFileForTarget: MobileProcessFileForTarget;
}

export const MobileWeightToolSection: React.FC<MobileWeightToolSectionProps> = ({
  processFileForTarget,
}) => {
  const [weightDirection, setWeightDirection] = useState<'sd2nai' | 'nai2sd'>('sd2nai');
  const [weightInput, setWeightInput] = useState('');
  const [weightOutput, setWeightOutput] = useState('');
  const [weightCopied, setWeightCopied] = useState(false);
  const [weightStripLora, setWeightStripLora] = useState(true);
  const [weightPage, setWeightPage] = useState<'input' | 'output'>('input');

  const handleWeightConvert = useCallback(() => {
    if (!weightInput.trim()) {
      setWeightOutput('');
      return;
    }
    try {
      let input = weightInput;
      if (weightStripLora) {
        input = input.replace(/<lora:[^>]*>/g, '').replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim();
      }
      const result = weightDirection === 'sd2nai'
        ? mobileWeightConvert.convertSDToNAI(input)
        : mobileWeightConvert.convertNAIToSD(input);
      setWeightOutput(result);
      setWeightPage('output');
    } catch {
      setWeightOutput('转换失败');
      setWeightPage('output');
    }
  }, [weightDirection, weightInput, weightStripLora]);

  const handleWeightCopy = useCallback(() => {
    if (!weightOutput) return;
    navigator.clipboard.writeText(weightOutput);
    setWeightCopied(true);
    setTimeout(() => setWeightCopied(false), 1500);
  }, [weightOutput]);

  if (weightPage === 'output') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="shrink-0 flex items-center gap-3 px-4 pt-3 pb-2">
          <button onClick={() => setWeightPage('input')} className="p-1.5 rounded-lg active:bg-gray-700">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="text-sm font-medium text-gray-300">{weightDirection === 'sd2nai' ? 'NAI 格式结果' : 'SD 格式结果'}</span>
          {weightDirection === 'sd2nai' && weightOutput && (
            <button
              onClick={() => {
                processFileForTarget('import', {
                  source: '',
                  sourceType: 'unknown' as any,
                  prompt: weightOutput,
                  negativePrompt: '',
                  width: 0,
                  height: 0,
                  seed: 0,
                }, {
                  prompt: true,
                  negativePrompt: false,
                  characters: false,
                  appendCharacters: false,
                  settings: false,
                  seed: false,
                  vibes: false,
                  cleanImports: false,
                });
                window.dispatchEvent(new CustomEvent('switch-to-generate'));
              }}
              className="flex items-center gap-1 text-xs text-nai-accent active:text-nai-accent/70 px-2 py-1 rounded-lg ml-auto"
            >
              <Download className="w-3.5 h-3.5" />
              导入提示词
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 px-4 pb-2">
          <div className="h-full w-full px-3 py-2.5 bg-gray-900/60 border border-gray-700 rounded-xl text-sm text-gray-200 font-mono whitespace-pre-wrap break-all overflow-y-auto">
            {weightOutput
              ? (weightDirection === 'sd2nai' ? mobileWeightConvert.renderNAIHighlighted(weightOutput) : mobileWeightConvert.renderSDHighlighted(weightOutput))
              : null}
          </div>
        </div>

        <div className="shrink-0 px-4 py-3">
          <button onClick={handleWeightCopy} disabled={!weightOutput} className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent text-black rounded-xl text-sm font-bold disabled:opacity-40">
            {weightCopied ? <><Check className="w-4 h-4" />已复制</> : <><Copy className="w-4 h-4" />复制结果</>}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center gap-3 px-4 pt-3 pb-2">
        <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700">
          <button
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${weightDirection === 'sd2nai' ? 'bg-nai-accent text-black' : 'text-gray-400'}`}
            onClick={() => { setWeightDirection('sd2nai'); setWeightOutput(''); }}
          >SD → NAI</button>
          <button
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${weightDirection === 'nai2sd' ? 'bg-nai-accent text-black' : 'text-gray-400'}`}
            onClick={() => { setWeightDirection('nai2sd'); setWeightOutput(''); }}
          >NAI → SD</button>
        </div>
        {weightDirection === 'sd2nai' && (
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={weightStripLora} onChange={(event) => setWeightStripLora(event.target.checked)} className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-nai-accent" />
            <span className="text-xs text-gray-400">去除 Lora</span>
          </label>
        )}
      </div>

      <div className="flex-1 flex flex-col min-h-0 px-4 pb-2">
        <div className="text-xs text-gray-400 mb-1 shrink-0">{weightDirection === 'sd2nai' ? 'SD 格式' : 'NAI 格式'}</div>
        <textarea
          value={weightInput}
          onChange={(event) => setWeightInput(event.target.value)}
          placeholder={weightDirection === 'sd2nai' ? '(masterpiece:1.2), (best quality), 1girl' : '1.2::masterpiece::, {best quality}, 1girl'}
          className="flex-1 w-full px-3 py-2.5 bg-gray-900/60 border border-gray-700 rounded-xl text-sm text-white placeholder-gray-600 focus:outline-none focus:border-nai-accent/50 resize-none font-mono"
        />
      </div>

      <div className="shrink-0 px-4 py-3">
        <button
          onClick={handleWeightConvert}
          disabled={!weightInput.trim()}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent text-black rounded-xl text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowLeftRight className="w-4 h-4" />
          转换
        </button>
      </div>
    </div>
  );
};
