'use client';

import { useSession, signIn, signOut } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";

// --- Types ---
interface Block {
  id: string;
  day: number;        // 0=월 ... 6=일
  start: number;       // 자정 기준 분 (예: 540 = 09:00)
  end: number;
  title: string;
  color: string;
  source: 'manual' | 'google';
  notionPageId?: string;
}

interface DragState {
  day: number;
  startSlot: number;
  currentSlot: number;
}

interface PendingBlock {
  id: string | null;   // 기존 블록 수정이면 id 존재, 새 블록이면 null
  day: number;
  start: number;
  end: number;
  title: string;
  color: string;
}

interface ModalState {
  show: boolean;
  message: string;
  onConfirm: (() => void) | null;
}

// Electron IPC Renderer (Window 객체 안전 확인)
const ipcRenderer = typeof window !== 'undefined' && (window as any).require
  ? (window as any).require('electron').ipcRenderer
  : null;

// --- 그리드 설정 ---
const DAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];
const START_HOUR = 6;         // 06:00부터
const END_HOUR = 24;          // 24:00까지
const SLOT_MIN = 30;          // 30분 단위
const ROW_HEIGHT = 18;        // px
const SLOTS_PER_DAY = ((END_HOUR - START_HOUR) * 60) / SLOT_MIN;
const START_MIN = START_HOUR * 60;

const COLORS = ['#8b8bff', '#ff8ba7', '#7fd8a6', '#ffd27f', '#7fc4ff', '#c99bff', '#ff9f7f'];

function jsDayToIndex(jsDay: number) {
  // JS: 0=일 ... 6=토  ->  0=월 ... 6=일
  return jsDay === 0 ? 6 : jsDay - 1;
}

function minutesToLabel(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getWeekRange(): { monday: Date; sunday: Date } {
  const now = new Date();
  const idx = jsDayToIndex(now.getDay());
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - idx);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

export default function TimetableWidget() {
  const { data: session } = useSession() as { data: any };

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [modal, setModal] = useState<ModalState>({ show: false, message: "", onConfirm: null });
  const [pending, setPending] = useState<PendingBlock | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [googleSyncEnabled, setGoogleSyncEnabled] = useState<boolean>(false);
  const [loadingGoogleEvents, setLoadingGoogleEvents] = useState(false);

  const gridRef = useRef<HTMLDivElement>(null);

  const openModal = (message: string, onConfirm: () => void) =>
    setModal({ show: true, message, onConfirm });
  const handleExit = () => openModal("위젯을 종료하시겠습니까?", () => ipcRenderer && window.close());

  useEffect(() => {
    if (ipcRenderer) {
      const handleFocus = (_: any, focused: boolean) => setIsFocused(focused);
      ipcRenderer.on('window-focus', handleFocus);
      return () => ipcRenderer.removeListener('window-focus', handleFocus);
    }
  }, []);

  // 설정값(구글 캘린더 자동표시 on/off)은 기기별 설정이므로 로컬에 저장
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('timetable_google_sync_enabled') : null;
    if (saved) setGoogleSyncEnabled(saved === 'true');
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('timetable_google_sync_enabled', String(googleSyncEnabled));
    }
  }, [googleSyncEnabled]);

  // --- Notion에서 저장된 타임테이블 불러오기 ---
  const loadFromNotion = async () => {
    try {
      const res = await fetch('/api/notion');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '불러오기 실패');
      setBlocks(prev => [...data.blocks, ...prev.filter(b => b.source === 'google')]);
      setSyncError(null);
    } catch (error: any) {
      console.error(error);
      setSyncError(error.message || '불러오기 실패');
    }
  };

  useEffect(() => {
    if (session) loadFromNotion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // --- 구글 캘린더 일정 자동 표시 ---
  const fetchGoogleEvents = async () => {
    if (!session?.accessToken) return;
    setLoadingGoogleEvents(true);
    try {
      const { monday, sunday } = getWeekRange();
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${monday.toISOString()}&timeMax=${sunday.toISOString()}&singleEvents=true&orderBy=startTime`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      const data = await res.json();
      const items = data.items || [];

      const googleBlocks: Block[] = items
        .filter((ev: any) => ev.start?.dateTime && ev.end?.dateTime) // 종일 일정은 그리드에서 제외
        .map((ev: any) => {
          const startDate = new Date(ev.start.dateTime);
          const endDate = new Date(ev.end.dateTime);
          const day = jsDayToIndex(startDate.getDay());
          const start = startDate.getHours() * 60 + startDate.getMinutes();
          let end = endDate.getHours() * 60 + endDate.getMinutes();
          if (jsDayToIndex(endDate.getDay()) !== day) end = 24 * 60; // 자정 넘어가면 해당일 끝까지만 표시
          return {
            id: `google-${ev.id}`,
            day,
            start: Math.max(start, START_MIN),
            end: Math.min(Math.max(end, start + 15), 24 * 60),
            title: ev.summary || '(제목 없음)',
            color: '#ffffff',
            source: 'google' as const,
          };
        });

      setBlocks(prev => [...prev.filter(b => b.source !== 'google'), ...googleBlocks]);
    } catch (error) {
      console.error('Google Calendar fetch error:', error);
    } finally {
      setLoadingGoogleEvents(false);
    }
  };

  useEffect(() => {
    if (googleSyncEnabled && session) {
      fetchGoogleEvents();
    } else {
      setBlocks(prev => prev.filter(b => b.source !== 'google'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleSyncEnabled, session]);

  // --- Notion으로 저장(동기화 버튼) ---
  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const manualBlocks = blocks.filter(b => b.source === 'manual');
      const res = await fetch('/api/notion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: manualBlocks }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '동기화 실패');
      setBlocks(prev => [...data.blocks, ...prev.filter(b => b.source === 'google')]);
      setLastSyncedAt(new Date());
    } catch (error: any) {
      console.error(error);
      setSyncError(error.message || '동기화 실패');
    } finally {
      setSyncing(false);
    }
  };

  // --- 드래그로 블록 생성 ---
  const handleMouseDown = (day: number, slot: number) => {
    setIsDragging(true);
    setDrag({ day, startSlot: slot, currentSlot: slot });
  };
  const handleMouseEnter = (day: number, slot: number) => {
    if (!isDragging || !drag || drag.day !== day) return;
    setDrag({ ...drag, currentSlot: slot });
  };
  useEffect(() => {
    const handleUp = () => {
      if (isDragging && drag) {
        const lo = Math.min(drag.startSlot, drag.currentSlot);
        const hi = Math.max(drag.startSlot, drag.currentSlot);
        const start = START_MIN + lo * SLOT_MIN;
        const end = START_MIN + (hi + 1) * SLOT_MIN;
        setPending({ id: null, day: drag.day, start, end, title: '', color: COLORS[0] });
      }
      setIsDragging(false);
      setDrag(null);
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, [isDragging, drag]);

  const openEditBlock = (block: Block) => {
    if (block.source !== 'manual') return; // 구글 일정은 읽기 전용
    setPending({ id: block.id, day: block.day, start: block.start, end: block.end, title: block.title, color: block.color });
  };

  const savePending = () => {
    if (!pending) return;
    if (!pending.title.trim()) return;
    if (pending.id) {
      setBlocks(prev => prev.map(b => (b.id === pending.id ? { ...b, title: pending.title, color: pending.color } : b)));
    } else {
      setBlocks(prev => [
        ...prev,
        { id: `local-${Date.now()}`, day: pending.day, start: pending.start, end: pending.end, title: pending.title, color: pending.color, source: 'manual' },
      ]);
    }
    setPending(null);
  };

  const deletePending = () => {
    if (!pending?.id) return;
    openModal('이 일정을 삭제하시겠습니까?', () => {
      setBlocks(prev => prev.filter(b => b.id !== pending.id));
      setPending(null);
    });
  };

  const blocksByDay = useMemo(() => {
    const map: Record<number, Block[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    blocks.forEach(b => map[b.day]?.push(b));
    return map;
  }, [blocks]);

  const hourMarks = useMemo(() => {
    const arr: number[] = [];
    for (let h = START_HOUR; h <= END_HOUR; h++) arr.push(h);
    return arr;
  }, []);

  if (!session) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black/15 backdrop-blur-3xl rounded-[45px] text-white">
        <button onClick={() => signIn("google")} className="bg-white/10 px-6 py-2 rounded-2xl">Connect Google</button>
      </div>
    );
  }

  return (
    <div className={`w-full h-full p-6 transition-all duration-700 backdrop-blur-3xl rounded-[45px] flex flex-col relative text-white border border-white/5 overflow-hidden ${isFocused ? 'bg-black/25' : 'bg-black/15'}`}>
      <div style={{ WebkitAppRegion: 'drag' } as any} className="absolute top-0 left-0 right-0 h-10 cursor-move z-40" />

      {/* 확인 모달 */}
      {modal.show && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div className="relative bg-white/10 backdrop-blur-2xl border border-white/10 p-6 rounded-[30px] w-full shadow-2xl">
            <p className="text-center text-[14px] font-medium mb-5 opacity-90">{modal.message}</p>
            <div className="flex gap-2">
              <button onClick={() => setModal({ ...modal, show: false })} className="flex-1 py-2 rounded-xl bg-white/5 hover:bg-white/15 text-[12px] transition-all">취소</button>
              <button onClick={() => { modal.onConfirm?.(); setModal({ ...modal, show: false }); }} className="flex-1 py-2 rounded-xl bg-black/20 hover:bg-black/80 text-[12px] transition-all font-bold border border-white/5">확인</button>
            </div>
          </div>
        </div>
      )}

      {/* 블록 생성/수정 모달 */}
      {pending && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setPending(null)} />
          <div className="relative bg-white/10 backdrop-blur-2xl border border-white/10 p-6 rounded-[30px] w-full shadow-2xl">
            <p className="text-[10px] opacity-60 mb-2 font-bold tracking-wider">
              {DAY_LABELS[pending.day]}요일 · {minutesToLabel(pending.start)} - {minutesToLabel(pending.end)}
            </p>
            <input
              autoFocus
              value={pending.title}
              onChange={(e) => setPending({ ...pending, title: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && savePending()}
              placeholder="일정 이름"
              spellCheck={false}
              className="w-full bg-white/5 rounded-[15px] py-2 px-4 text-[13px] mb-3 outline-none border border-white/5"
            />
            <div className="flex gap-2 mb-4">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setPending({ ...pending, color: c })}
                  style={{ backgroundColor: c }}
                  className={`w-6 h-6 rounded-full transition-all ${pending.color === c ? 'ring-2 ring-white scale-110' : 'opacity-70'}`}
                />
              ))}
            </div>
            <div className="flex gap-2">
              {pending.id && (
                <button onClick={deletePending} className="py-2 px-4 rounded-xl bg-red-500/20 hover:bg-red-500/40 text-[12px] transition-all">삭제</button>
              )}
              <button onClick={() => setPending(null)} className="flex-1 py-2 rounded-xl bg-white/5 hover:bg-white/15 text-[12px] transition-all">취소</button>
              <button onClick={savePending} className="flex-1 py-2 rounded-xl bg-black/20 hover:bg-black/80 text-[12px] font-bold border border-white/5 transition-all">저장</button>
            </div>
          </div>
        </div>
      )}

      {/* 설정 패널 */}
      {showSettings && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowSettings(false)} />
          <div className="relative bg-white/10 backdrop-blur-2xl border border-white/10 p-6 rounded-[30px] w-full shadow-2xl">
            <h2 className="text-[13px] font-bold mb-4 opacity-90">설정</h2>
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-[12px] font-medium">구글 캘린더 자동 표시</p>
                <p className="text-[10px] opacity-50 mt-0.5">이번 주 일정을 타임테이블에 자동으로 불러옵니다</p>
              </div>
              <button
                onClick={() => setGoogleSyncEnabled(v => !v)}
                className={`w-10 h-6 rounded-full transition-all relative shrink-0 ${googleSyncEnabled ? 'bg-white' : 'bg-white/15'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${googleSyncEnabled ? 'right-0.5 bg-black' : 'left-0.5 bg-white/60'}`} />
              </button>
            </div>
            {loadingGoogleEvents && <p className="text-[10px] opacity-50 mt-1">불러오는 중...</p>}
            <button onClick={() => setShowSettings(false)} className="w-full mt-5 py-2 rounded-xl bg-white/5 hover:bg-white/15 text-[12px] transition-all">닫기</button>
          </div>
        </div>
      )}

      {/* 헤더 */}
      <header className="mt-2 mb-3 flex justify-between items-center z-50" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <div className="flex items-center gap-2">
          <h1 className="font-bold text-xl tracking-tight opacity-90">Timetable</h1>
          {googleSyncEnabled && <span className="text-[9px] bg-white/10 px-2 py-0.5 rounded-full opacity-70">G 연동중</span>}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="text-[10px] bg-white/10 hover:bg-white/20 px-3 py-1 rounded-full font-bold transition-all disabled:opacity-40"
          >
            {syncing ? '동기화 중...' : '동기화'}
          </button>
          <button onClick={() => setShowSettings(true)} className="text-[14px] opacity-40 hover:opacity-100 transition-all">⚙</button>
          <button onClick={() => signOut()} className="text-[10px] opacity-40 hover:opacity-100 transition-opacity">Logout</button>
          <button onClick={handleExit} className="text-[14px] opacity-40 hover:opacity-100 transition-all font-bold">✕</button>
        </div>
      </header>

      <div className="flex justify-between items-center mb-1 px-1 z-50">
        <p className="text-[9px] opacity-40">
          {lastSyncedAt ? `마지막 동기화 ${lastSyncedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '아직 동기화되지 않음'}
        </p>
        {syncError && <p className="text-[9px] text-red-300">{syncError}</p>}
      </div>

      {/* 그리드 */}
      <div className="flex-1 overflow-y-auto custom-scrollbar" style={{ WebkitAppRegion: 'no-drag' } as any} ref={gridRef}>
        <div className="flex">
          {/* 시간 라벨 열 */}
          <div className="w-9 shrink-0 pt-5">
            {hourMarks.map((h) => (
              <div key={h} style={{ height: ROW_HEIGHT * 2 }} className="text-[8px] opacity-40 -translate-y-1.5">
                {h}
              </div>
            ))}
          </div>

          {/* 요일 열들 */}
          {DAY_LABELS.map((label, day) => (
            <div key={day} className="flex-1 min-w-0">
              <div className="text-[10px] text-center font-bold opacity-60 mb-1 sticky top-0">{label}</div>
              <div
                className="relative border-l border-white/5"
                style={{ height: SLOTS_PER_DAY * ROW_HEIGHT }}
              >
                {/* 빈 슬롯들 (드래그 영역) */}
                {Array.from({ length: SLOTS_PER_DAY }).map((_, slot) => {
                  const inDrag = isDragging && drag?.day === day &&
                    slot >= Math.min(drag.startSlot, drag.currentSlot) &&
                    slot <= Math.max(drag.startSlot, drag.currentSlot);
                  return (
                    <div
                      key={slot}
                      onMouseDown={() => handleMouseDown(day, slot)}
                      onMouseEnter={() => handleMouseEnter(day, slot)}
                      style={{ height: ROW_HEIGHT }}
                      className={`border-t border-white/[0.03] cursor-pointer ${inDrag ? 'bg-white/10' : 'hover:bg-white/5'}`}
                    />
                  );
                })}

                {/* 블록 렌더링 */}
                {blocksByDay[day].map((b) => {
                  const top = ((b.start - START_MIN) / SLOT_MIN) * ROW_HEIGHT;
                  const height = Math.max(((b.end - b.start) / SLOT_MIN) * ROW_HEIGHT, ROW_HEIGHT * 0.9);
                  const isGoogle = b.source === 'google';
                  return (
                    <div
                      key={b.id}
                      onClick={(e) => { e.stopPropagation(); openEditBlock(b); }}
                      title={`${b.title} (${minutesToLabel(b.start)}-${minutesToLabel(b.end)})`}
                      style={{
                        top,
                        height,
                        backgroundColor: isGoogle ? 'transparent' : `${b.color}33`,
                        borderColor: isGoogle ? 'rgba(255,255,255,0.5)' : b.color,
                      }}
                      className={`absolute left-0.5 right-0.5 rounded-[8px] border px-1.5 py-0.5 overflow-hidden ${isGoogle ? 'border-dashed cursor-default' : 'cursor-pointer hover:brightness-125'}`}
                    >
                      <p className="text-[8px] font-bold leading-tight truncate opacity-90">{b.title}</p>
                      {height > 24 && <p className="text-[7px] opacity-50 leading-tight">{minutesToLabel(b.start)}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[8px] opacity-30 text-center mt-2">드래그해서 일정 추가 · 클릭해서 수정 (구글 일정은 읽기 전용)</p>
    </div>
  );
}
