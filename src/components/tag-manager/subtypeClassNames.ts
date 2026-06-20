import type { ColorTone } from './types';

export interface ToneClasses {
  bg: string;
  border: string;
  hoverBg: string;
  text: string;
  ring: string;
  solidBg: string;
}

const TONE_MAP: Record<ColorTone, ToneClasses> = {
  amber:   { bg: 'bg-amber-500/20',   border: 'border-amber-500/50',   hoverBg: 'hover:bg-amber-500/30',   text: 'text-amber-300',   ring: 'ring-amber-500/40',   solidBg: 'bg-amber-500' },
  sky:     { bg: 'bg-sky-500/20',     border: 'border-sky-500/50',     hoverBg: 'hover:bg-sky-500/30',     text: 'text-sky-300',     ring: 'ring-sky-500/40',     solidBg: 'bg-sky-500' },
  emerald: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/50', hoverBg: 'hover:bg-emerald-500/30', text: 'text-emerald-300', ring: 'ring-emerald-500/40', solidBg: 'bg-emerald-500' },
  rose:    { bg: 'bg-rose-500/20',    border: 'border-rose-500/50',    hoverBg: 'hover:bg-rose-500/30',    text: 'text-rose-300',    ring: 'ring-rose-500/40',    solidBg: 'bg-rose-500' },
  slate:   { bg: 'bg-slate-500/20',   border: 'border-slate-500/50',   hoverBg: 'hover:bg-slate-500/30',   text: 'text-slate-300',   ring: 'ring-slate-500/40',   solidBg: 'bg-slate-500' },
  cyan:    { bg: 'bg-cyan-500/20',    border: 'border-cyan-500/50',    hoverBg: 'hover:bg-cyan-500/30',    text: 'text-cyan-300',    ring: 'ring-cyan-500/40',    solidBg: 'bg-cyan-500' },
  lime:    { bg: 'bg-lime-500/20',    border: 'border-lime-500/50',    hoverBg: 'hover:bg-lime-500/30',    text: 'text-lime-300',    ring: 'ring-lime-500/40',    solidBg: 'bg-lime-500' },
  orange:  { bg: 'bg-orange-500/20',  border: 'border-orange-500/50',  hoverBg: 'hover:bg-orange-500/30',  text: 'text-orange-300',  ring: 'ring-orange-500/40',  solidBg: 'bg-orange-500' },
  teal:    { bg: 'bg-teal-500/20',    border: 'border-teal-500/50',    hoverBg: 'hover:bg-teal-500/30',    text: 'text-teal-300',    ring: 'ring-teal-500/40',    solidBg: 'bg-teal-500' },
};

export function subtypeClassNames(tone: ColorTone): ToneClasses {
  return TONE_MAP[tone] || TONE_MAP.amber;
}

export const ALL_TONES: ColorTone[] = ['amber', 'sky', 'emerald', 'rose', 'slate', 'cyan', 'lime', 'orange', 'teal'];
