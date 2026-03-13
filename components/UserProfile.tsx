import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, CheckCheck, Send, ChevronRight, ArrowRight } from 'lucide-react';
import {
  doc, getDoc, setDoc, updateDoc, collection,
  addDoc, onSnapshot, query, where, orderBy,
  serverTimestamp, increment, getDocs, limit
} from 'firebase/firestore';
import { db } from '../firebase';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initDataUnsafe?: {
          user?: { id: number; first_name: string; last_name?: string; username?: string; photo_url?: string; };
          start_param?: string;
        };
        openTelegramLink?: (url: string) => void;
      };
    };
  }
}

interface UserData {
  telegramId: string; name: string; username?: string; photo?: string;
  coins: number; takaBalance: number; referralCode: string;
  referredBy?: string; referralCount: number; joinedAt: any;
  lastLogin: any; milestonesClaimed: number[]; unlockedMovies?: string[];
}
interface WithdrawalRequest {
  id?: string; userId: string; userName: string; amount: number;
  method: 'bkash' | 'nagad'; number: string;
  status: 'pending' | 'success' | 'cancelled'; adminNote?: string; createdAt: any;
}
interface CoinHistory { id?: string; type: 'earn' | 'spend'; reason: string; amount: number; createdAt: any; }
interface UserProfileProps { onClose: () => void; botUsername: string; }

const MILESTONES = [{ count: 5, bonus: 50 }, { count: 10, bonus: 150 }, { count: 20, bonus: 400 }, { count: 50, bonus: 1000 }];
const MIN_WITHDRAW_TAKA = 50;

const UserProfile: React.FC<UserProfileProps> = ({ onClose, botUsername }) => {
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<'main' | 'convert' | 'withdraw' | 'history'>('main');
  const [copied, setCopied] = useState(false);
  const [withdrawMethod, setWithdrawMethod] = useState<'bkash' | 'nagad'>('bkash');
  const [withdrawNumber, setWithdrawNumber] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [coinHistory, setCoinHistory] = useState<CoinHistory[]>([]);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [convertCoins, setConvertCoins] = useState('');
  const [convertLoading, setConvertLoading] = useState(false);
  const [actualBot, setActualBot] = useState(botUsername || '');

  const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param || '';

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    getDoc(doc(db, 'settings', 'app')).then(s => { if (s.exists() && s.data().botUsername) setActualBot(s.data().botUsername); }).catch(() => {});
  }, []);

  const addCoinLog = async (uid: string, type: 'earn' | 'spend', reason: string, amount: number) =>
    addDoc(collection(db, `users/${uid}/coinHistory`), { type, reason, amount, createdAt: serverTimestamp() });

  useEffect(() => {
    if (!tgUser) { setLoading(false); return; }
    (async () => {
      const uid = String(tgUser.id);
      const ref = doc(db, 'users', uid);
      try {
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          const code = `CIN${uid.slice(-6)}`;
          const nu: UserData = { telegramId: uid, name: `${tgUser.first_name}${tgUser.last_name ? ' ' + tgUser.last_name : ''}`, username: tgUser.username, photo: tgUser.photo_url, coins: 50, takaBalance: 0, referralCode: code, referralCount: 0, joinedAt: serverTimestamp(), lastLogin: serverTimestamp(), milestonesClaimed: [], unlockedMovies: [] };
          await setDoc(ref, nu);
          await addCoinLog(uid, 'earn', '🎁 Welcome Bonus', 50);
          if (startParam?.startsWith('ref_')) {
            const refCode = startParam.replace('ref_', '');
            const q = query(collection(db, 'users'), where('referralCode', '==', refCode), limit(1));
            const rs = await getDocs(q);
            if (!rs.empty && rs.docs[0].id !== uid) {
              await updateDoc(ref, { referredBy: rs.docs[0].id });
              await addDoc(collection(db, 'pendingReferrals'), { referrerId: rs.docs[0].id, newUserId: uid, completed: false, createdAt: serverTimestamp() });
            }
          }
          setUserData({ ...nu, joinedAt: new Date(), lastLogin: new Date() });
        } else {
          const data = snap.data() as UserData;
          const last = data.lastLogin?.toDate?.() || new Date(0);
          if (new Date().toDateString() !== last.toDateString()) {
            await updateDoc(ref, { coins: increment(5), lastLogin: serverTimestamp() });
            await addCoinLog(uid, 'earn', '📅 Daily Login', 5);
            showToast('+5 Coin! Daily Login 🪙');
          } else { await updateDoc(ref, { lastLogin: serverTimestamp() }); }
          setUserData(data);
        }
      } catch (e) {}
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!tgUser) return;
    const uid = String(tgUser.id);
    return onSnapshot(doc(db, 'users', uid), s => { if (s.exists()) setUserData(s.data() as UserData); });
  }, [tgUser]);

  useEffect(() => {
    if (!tgUser) return;
    const uid = String(tgUser.id);
    return onSnapshot(query(collection(db, 'withdrawals'), where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(10)), s => setWithdrawals(s.docs.map(d => ({ id: d.id, ...d.data() } as WithdrawalRequest))));
  }, [tgUser]);

  useEffect(() => {
    if (!tgUser) return;
    const uid = String(tgUser.id);
    return onSnapshot(query(collection(db, `users/${uid}/coinHistory`), orderBy('createdAt', 'desc'), limit(30)), s => setCoinHistory(s.docs.map(d => ({ id: d.id, ...d.data() } as CoinHistory))));
  }, [tgUser]);

  const completeReferral = async () => {
    if (!tgUser) return;
    const uid = String(tgUser.id);
    try {
      const q = query(collection(db, 'pendingReferrals'), where('newUserId', '==', uid), where('completed', '==', false), limit(1));
      const snap = await getDocs(q);
      if (snap.empty) return;
      const pd = snap.docs[0]; const { referrerId } = pd.data();
      await updateDoc(doc(db, 'pendingReferrals', pd.id), { completed: true });
      const rref = doc(db, 'users', referrerId);
      const rsnap = await getDoc(rref);
      if (!rsnap.exists()) return;
      const rd = rsnap.data() as UserData;
      const nc = (rd.referralCount || 0) + 1;
      await updateDoc(rref, { coins: increment(100), referralCount: increment(1) });
      await addCoinLog(referrerId, 'earn', `👥 Referral - ${userData?.name || 'বন্ধু'}`, 100);
      for (const m of MILESTONES) {
        if (nc >= m.count && !rd.milestonesClaimed?.includes(m.count)) {
          await updateDoc(rref, { coins: increment(m.bonus), milestonesClaimed: [...(rd.milestonesClaimed || []), m.count] });
          await addCoinLog(referrerId, 'earn', `🎯 ${m.count} Refer Milestone!`, m.bonus);
        }
      }
    } catch (e) {}
  };
  useEffect(() => { (window as any).completeCinelixReferral = completeReferral; }, [tgUser, userData]);

  const getLink = () => !userData?.referralCode ? '' : `https://t.me/${actualBot || 'YourBot'}?startapp=ref_${userData.referralCode}`;
  const copyLink = async () => { const l = getLink(); if (!l) return; await navigator.clipboard.writeText(l); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const shareLink = () => {
    const l = getLink(); if (!l) return;
    const t = `🎬 CineFlix — সেরা Movie App!\n\n🎁 Join করলেই 50 Coin বোনাস!\n💰 Refer করে আয় করো!\n\n${l}`;
    window.Telegram?.WebApp?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(l)}&text=${encodeURIComponent(t)}`);
  };

  const convertedTaka = parseInt(convertCoins) >= 500 ? ((parseInt(convertCoins) / 1000) * 10).toFixed(2) : null;
  const canWithdraw = (userData?.takaBalance || 0) >= MIN_WITHDRAW_TAKA;
  const canConvert = (userData?.coins || 0) >= 500;
  const progressPct = Math.min(100, ((userData?.coins || 0) / 5000) * 100);

  const handleConvert = async () => {
    if (!tgUser || !userData) return;
    const coins = parseInt(convertCoins);
    if (!coins || coins < 500 || coins % 500 !== 0) { showToast('500 এর গুণিতকে দাও!', 'error'); return; }
    if (coins > userData.coins) { showToast('Coin কম!', 'error'); return; }
    const taka = (coins / 1000) * 10;
    setConvertLoading(true);
    try {
      await updateDoc(doc(db, 'users', String(tgUser.id)), { coins: increment(-coins), takaBalance: increment(taka) });
      await addCoinLog(String(tgUser.id), 'spend', `💱 ${coins} Coin → ৳${taka}`, coins);
      setConvertCoins(''); setScreen('main'); showToast(`৳${taka} যোগ হয়েছে! 💰`);
    } catch (e) { showToast('Error!', 'error'); }
    setConvertLoading(false);
  };

  const handleWithdraw = async () => {
    if (!tgUser || !userData) return;
    const amount = parseFloat(withdrawAmount);
    if (!withdrawNumber || withdrawNumber.length < 11) { showToast('সঠিক নম্বর দাও!', 'error'); return; }
    if (!amount || amount < MIN_WITHDRAW_TAKA) { showToast(`Minimum ৳${MIN_WITHDRAW_TAKA}!`, 'error'); return; }
    if (amount > userData.takaBalance) { showToast('Balance কম!', 'error'); return; }
    setWithdrawLoading(true);
    try {
      await addDoc(collection(db, 'withdrawals'), { userId: String(tgUser.id), userName: userData.name, amount, method: withdrawMethod, number: withdrawNumber, status: 'pending', adminNote: '', createdAt: serverTimestamp() });
      await updateDoc(doc(db, 'users', String(tgUser.id)), { takaBalance: increment(-amount) });
      setWithdrawNumber(''); setWithdrawAmount(''); setScreen('main'); showToast('Request পাঠানো হয়েছে! ✅');
    } catch (e) { showToast('Error!', 'error'); }
    setWithdrawLoading(false);
  };

  if (!tgUser && !loading) return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-[#080808] flex flex-col items-center justify-center px-8">
      <button onClick={onClose} className="absolute top-6 right-5 w-9 h-9 bg-white/10 rounded-full flex items-center justify-center"><X size={18} className="text-white" /></button>
      <div className="text-6xl mb-4">📱</div>
      <p className="text-white text-lg font-bold">Telegram Mini App</p>
      <p className="text-gray-500 text-sm mt-2 text-center">শুধু Telegram এ কাজ করে</p>
    </motion.div>
  );

  if (loading) return (
    <div className="fixed inset-0 z-50 bg-[#080808] flex items-center justify-center">
      <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} className="w-10 h-10 border-2 border-gold/20 border-t-gold rounded-full" />
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-[#080808] overflow-hidden flex flex-col">
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: -30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -30 }}
            className={`absolute top-4 left-4 right-4 z-[70] px-4 py-3 rounded-2xl text-sm font-medium text-center shadow-xl ${toast.type === 'success' ? 'bg-green-500/90 text-white' : 'bg-red-500/90 text-white'}`}>
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">

        {/* ── MAIN ── */}
        {screen === 'main' && (
          <motion.div key="main" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, x: -30 }} className="flex-1 overflow-y-auto">
            {/* Header */}
            <div className="relative px-5 pt-12 pb-5" style={{ background: 'linear-gradient(180deg, #131313 0%, #080808 100%)' }}>
              <button onClick={onClose} className="absolute top-5 right-5 w-9 h-9 bg-white/8 rounded-full flex items-center justify-center">
                <X size={17} className="text-white" />
              </button>
              <div className="flex items-center gap-4">
                <div className="relative">
                  {userData?.photo ? <img src={userData.photo} className="w-14 h-14 rounded-2xl object-cover" alt="" />
                    : <div className="w-14 h-14 rounded-2xl bg-gold/15 flex items-center justify-center text-xl">👤</div>}
                  <div className="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-green-400 rounded-full border-2 border-[#131313]" />
                </div>
                <div>
                  <p className="text-white font-bold text-base leading-tight">{userData?.name}</p>
                  {userData?.username && <p className="text-gray-600 text-xs">@{userData.username}</p>}
                </div>
              </div>
            </div>

            <div className="px-4 space-y-3 pb-28">
              {/* Balance */}
              <div className="rounded-3xl overflow-hidden" style={{ background: 'linear-gradient(135deg, #1a1a1a 0%, #111 100%)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="grid grid-cols-2 divide-x divide-white/5">
                  <div className="p-5">
                    <p className="text-gray-600 text-xs mb-2 uppercase tracking-wider">Coin</p>
                    <p className="text-gold font-bold text-3xl">{(userData?.coins || 0).toLocaleString()}</p>
                    <p className="text-gray-700 text-xs mt-1">🪙 available</p>
                  </div>
                  <div className="p-5">
                    <p className="text-gray-600 text-xs mb-2 uppercase tracking-wider">Taka</p>
                    <p className="text-green-400 font-bold text-3xl">৳{(userData?.takaBalance || 0).toFixed(2)}</p>
                    <p className="text-gray-700 text-xs mt-1">💵 balance</p>
                  </div>
                </div>
                <div className="px-5 pb-4 pt-1">
                  <div className="flex justify-between text-xs text-gray-700 mb-1.5">
                    <span>Withdrawal goal</span>
                    <span>{Math.min(userData?.coins || 0, 5000).toLocaleString()} / 5000 🪙</span>
                  </div>
                  <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                    <motion.div className="h-full rounded-full" style={{ background: 'linear-gradient(90deg, #FFD700, #FFF176)' }}
                      initial={{ width: 0 }} animate={{ width: `${progressPct}%` }} transition={{ duration: 1.2, ease: 'easeOut' }} />
                  </div>
                  <p className="text-gray-700 text-xs mt-1.5">
                    {(userData?.coins || 0) < 5000 ? `আর ${5000 - (userData?.coins || 0)} coin = ৳50 withdraw` : '🎉 Withdraw করার যোগ্য!'}
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-3">
                <motion.button whileTap={{ scale: 0.96 }} onClick={() => canConvert ? setScreen('convert') : showToast('500 Coin হলে convert করতে পারবে!', 'error')}
                  className="relative rounded-2xl p-4 flex flex-col gap-2.5 overflow-hidden"
                  style={{ background: canConvert ? 'linear-gradient(135deg, rgba(255,215,0,0.15), rgba(255,215,0,0.05))' : '#111', border: canConvert ? '1px solid rgba(255,215,0,0.25)' : '1px solid rgba(255,255,255,0.05)' }}>
                  {!canConvert && <div className="absolute inset-0 rounded-2xl flex items-center justify-center" style={{ backdropFilter: 'blur(2px)', background: 'rgba(0,0,0,0.5)' }}>
                    <p className="text-gray-600 text-xs">🔒 500 coin</p>
                  </div>}
                  <span className="text-2xl">💱</span>
                  <div>
                    <p className={`font-bold text-sm ${canConvert ? 'text-gold' : 'text-gray-700'}`}>Convert</p>
                    <p className="text-gray-600 text-xs">Coin → Taka</p>
                  </div>
                </motion.button>

                <motion.button whileTap={{ scale: 0.96 }} onClick={() => canWithdraw ? setScreen('withdraw') : showToast('৳50 হলে withdraw করতে পারবে!', 'error')}
                  className="relative rounded-2xl p-4 flex flex-col gap-2.5 overflow-hidden"
                  style={{ background: canWithdraw ? 'linear-gradient(135deg, rgba(34,197,94,0.15), rgba(34,197,94,0.05))' : '#111', border: canWithdraw ? '1px solid rgba(34,197,94,0.25)' : '1px solid rgba(255,255,255,0.05)' }}>
                  {!canWithdraw && <div className="absolute inset-0 rounded-2xl flex items-center justify-center" style={{ backdropFilter: 'blur(2px)', background: 'rgba(0,0,0,0.5)' }}>
                    <p className="text-gray-600 text-xs">🔒 ৳50 দরকার</p>
                  </div>}
                  <span className="text-2xl">💸</span>
                  <div>
                    <p className={`font-bold text-sm ${canWithdraw ? 'text-green-400' : 'text-gray-700'}`}>Withdraw</p>
                    <p className="text-gray-600 text-xs">bKash / Nagad</p>
                  </div>
                </motion.button>
              </div>

              {/* Referral */}
              <div className="rounded-3xl p-5" style={{ background: '#111', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <p className="text-white font-bold text-sm">Referral</p>
                    <p className="text-gray-600 text-xs">প্রতি refer = 100 🪙 • {userData?.referralCount || 0} জন</p>
                  </div>
                  <div className="px-3 py-1.5 rounded-xl" style={{ background: 'rgba(255,215,0,0.08)', border: '1px solid rgba(255,215,0,0.2)' }}>
                    <p className="text-gold font-bold text-sm tracking-widest">{userData?.referralCode}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <motion.button whileTap={{ scale: 0.96 }} onClick={shareLink}
                    className="flex-1 py-3.5 rounded-2xl flex items-center justify-center gap-2 font-bold text-sm text-black"
                    style={{ background: 'linear-gradient(135deg, #FFD700, #FFC200)' }}>
                    <Send size={14} /> Share
                  </motion.button>
                  <motion.button whileTap={{ scale: 0.96 }} onClick={copyLink}
                    className="flex-1 py-3.5 rounded-2xl flex items-center justify-center gap-2 text-sm text-white"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    {copied ? <CheckCheck size={14} className="text-green-400" /> : <Copy size={14} />}
                    {copied ? 'Copied!' : 'Copy'}
                  </motion.button>
                </div>
                {(() => {
                  const next = MILESTONES.find(m => (userData?.referralCount || 0) < m.count);
                  if (!next) return null;
                  return (
                    <div className="mt-3 rounded-2xl p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
                      <div className="flex justify-between text-xs mb-2">
                        <span className="text-gray-600">{next.count} refer → +{next.bonus} bonus 🎯</span>
                        <span className="text-gold">{userData?.referralCount || 0}/{next.count}</span>
                      </div>
                      <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                        <motion.div className="h-full bg-gold rounded-full" initial={{ width: 0 }}
                          animate={{ width: `${Math.min(100, ((userData?.referralCount || 0) / next.count) * 100)}%` }} />
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Rate Table */}
              <div className="rounded-3xl p-5" style={{ background: '#111', border: '1px solid rgba(255,255,255,0.05)' }}>
                <p className="text-gray-600 text-xs uppercase tracking-widest mb-3">Conversion Rate</p>
                {[[500, 5], [1000, 10], [2000, 20], [5000, 50]].map(([coin, taka], i) => {
                  const has = (userData?.coins || 0) >= coin;
                  return (
                    <div key={i} className={`flex items-center py-2.5 ${i < 3 ? 'border-b border-white/5' : ''}`}>
                      <span className={`text-sm flex-1 ${has ? 'text-gold' : 'text-gray-700'}`}>🪙 {coin.toLocaleString()}</span>
                      <ArrowRight size={11} className="text-gray-800 mx-2" />
                      <span className={`text-sm font-bold flex-1 text-right ${has ? 'text-green-400' : 'text-gray-700'}`}>৳{taka}</span>
                      {taka >= 50 && <span className="ml-2 text-xs text-green-600 text-right">✓ withdraw</span>}
                    </div>
                  );
                })}
              </div>

              {/* History */}
              <motion.button whileTap={{ scale: 0.98 }} onClick={() => setScreen('history')}
                className="w-full p-4 rounded-2xl flex items-center justify-between" style={{ background: '#111', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex items-center gap-3">
                  <span className="text-xl">📊</span>
                  <div className="text-left">
                    <p className="text-white text-sm font-medium">History</p>
                    <p className="text-gray-600 text-xs">Coin ও Withdrawal</p>
                  </div>
                </div>
                <ChevronRight size={16} className="text-gray-700" />
              </motion.button>
            </div>
          </motion.div>
        )}

        {/* ── CONVERT ── */}
        {screen === 'convert' && (
          <motion.div key="convert" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex-1 overflow-y-auto px-5 pt-12 pb-10">
            <button onClick={() => setScreen('main')} className="mb-6 text-gray-500 text-sm flex items-center gap-1">← Back</button>
            <p className="text-white text-xl font-bold mb-1">Convert</p>
            <p className="text-gray-600 text-sm mb-5">1000 Coin = ৳10 • Minimum 500</p>

            <div className="rounded-2xl p-4 mb-4 flex justify-between items-center" style={{ background: '#111', border: '1px solid rgba(255,255,255,0.05)' }}>
              <p className="text-gray-500 text-sm">Available</p>
              <p className="text-gold font-bold">🪙 {(userData?.coins || 0).toLocaleString()}</p>
            </div>

            <div className="rounded-2xl overflow-hidden mb-3" style={{ background: '#111', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="px-4 py-4 border-b border-white/5">
                <p className="text-gray-700 text-xs mb-1">Coin</p>
                <input type="number" value={convertCoins} onChange={e => setConvertCoins(e.target.value)} placeholder="500, 1000, 1500..."
                  className="w-full bg-transparent text-white text-2xl font-bold outline-none placeholder:text-gray-800" />
              </div>
              <div className="px-4 py-4 flex justify-between items-center">
                <p className="text-gray-600 text-sm">= Taka</p>
                <p className={`text-2xl font-bold ${convertedTaka ? 'text-green-400' : 'text-gray-800'}`}>৳{convertedTaka || '0.00'}</p>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 mb-5">
              {[500, 1000, 2000, 5000].map(v => (
                <motion.button key={v} whileTap={{ scale: 0.95 }} onClick={() => setConvertCoins(String(v))}
                  className={`py-2.5 rounded-xl text-xs font-bold transition-all ${convertCoins === String(v) ? 'bg-gold text-black' : 'text-gray-500'}`}
                  style={{ background: convertCoins === String(v) ? '#FFD700' : 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  {v >= 1000 ? `${v/1000}K` : v}
                </motion.button>
              ))}
            </div>

            <motion.button whileTap={{ scale: 0.97 }} onClick={handleConvert} disabled={convertLoading || !convertedTaka}
              className={`w-full py-4 rounded-2xl font-bold text-sm flex items-center justify-center gap-2 ${convertedTaka ? 'text-black' : 'text-gray-600'}`}
              style={{ background: convertedTaka ? 'linear-gradient(135deg, #FFD700, #FFC200)' : 'rgba(255,255,255,0.05)' }}>
              {convertLoading ? <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity }} className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full" />
                : `Convert → ৳${convertedTaka || '0'}`}
            </motion.button>
          </motion.div>
        )}

        {/* ── WITHDRAW ── */}
        {screen === 'withdraw' && (
          <motion.div key="withdraw" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex-1 overflow-y-auto px-5 pt-12 pb-10">
            <button onClick={() => setScreen('main')} className="mb-6 text-gray-500 text-sm flex items-center gap-1">← Back</button>
            <p className="text-white text-xl font-bold mb-1">Withdrawal</p>
            <p className="text-gray-600 text-sm mb-5">Balance: ৳{(userData?.takaBalance || 0).toFixed(2)} • Min ৳{MIN_WITHDRAW_TAKA}</p>

            <div className="grid grid-cols-2 gap-3 mb-4">
              {([{ id: 'bkash' as const, label: 'bKash', color: '#E2136E', s: 'B' }, { id: 'nagad' as const, label: 'Nagad', color: '#F15A22', s: 'N' }]).map(m => (
                <motion.button key={m.id} whileTap={{ scale: 0.97 }} onClick={() => setWithdrawMethod(m.id)}
                  className="flex items-center gap-3 p-4 rounded-2xl transition-all"
                  style={{ border: withdrawMethod === m.id ? '2px solid rgba(255,255,255,0.2)' : '2px solid rgba(255,255,255,0.05)', background: withdrawMethod === m.id ? 'rgba(255,255,255,0.05)' : '#111' }}>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-black text-base flex-shrink-0" style={{ background: m.color }}>{m.s}</div>
                  <span className="text-white font-bold text-sm">{m.label}</span>
                  {withdrawMethod === m.id && <div className="ml-auto w-2 h-2 rounded-full bg-white" />}
                </motion.button>
              ))}
            </div>

            <div className="rounded-2xl overflow-hidden mb-3" style={{ background: '#111', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="flex items-center gap-3 px-4 py-4 border-b border-white/5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-black text-xs flex-shrink-0"
                  style={{ background: withdrawMethod === 'bkash' ? '#E2136E' : '#F15A22' }}>
                  {withdrawMethod === 'bkash' ? 'B' : 'N'}
                </div>
                <input type="tel" value={withdrawNumber} onChange={e => setWithdrawNumber(e.target.value)} placeholder="01XXXXXXXXX"
                  className="flex-1 bg-transparent text-white text-base outline-none placeholder:text-gray-800" />
              </div>
              <div className="flex items-center gap-3 px-4 py-4">
                <span className="text-gray-600">৳</span>
                <input type="number" value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)} placeholder={`Minimum ${MIN_WITHDRAW_TAKA}`}
                  className="flex-1 bg-transparent text-white text-base outline-none placeholder:text-gray-800" />
              </div>
            </div>

            <AnimatePresence>
              {withdrawNumber.length === 11 && (
                <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl mb-4"
                  style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.15)' }}>
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white font-black text-xs flex-shrink-0"
                    style={{ background: withdrawMethod === 'bkash' ? '#E2136E' : '#F15A22' }}>
                    {withdrawMethod === 'bkash' ? 'B' : 'N'}
                  </div>
                  <span className="text-white text-sm flex-1">{withdrawNumber}</span>
                  <span className="text-green-400 text-xs">✓</span>
                </motion.div>
              )}
            </AnimatePresence>

            <motion.button whileTap={{ scale: 0.97 }} onClick={handleWithdraw} disabled={withdrawLoading}
              className="w-full py-4 rounded-2xl font-bold text-sm text-white flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}>
              {withdrawLoading ? <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity }} className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full" /> : '✅ Request পাঠাও'}
            </motion.button>
          </motion.div>
        )}

        {/* ── HISTORY ── */}
        {screen === 'history' && (
          <motion.div key="history" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex-1 overflow-y-auto px-5 pt-12 pb-10">
            <button onClick={() => setScreen('main')} className="mb-6 text-gray-500 text-sm flex items-center gap-1">← Back</button>
            <p className="text-white text-xl font-bold mb-5">History</p>

            {withdrawals.length > 0 && <>
              <p className="text-gray-700 text-xs uppercase tracking-widest mb-3">Withdrawals</p>
              {withdrawals.map(w => (
                <div key={w.id} className="p-4 rounded-2xl mb-2.5" style={{ background: '#111', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-black text-xs flex-shrink-0"
                        style={{ background: w.method === 'bkash' ? '#E2136E' : '#F15A22' }}>{w.method === 'bkash' ? 'B' : 'N'}</div>
                      <div>
                        <p className="text-white text-sm">{w.number}</p>
                        <p className="text-gray-600 text-xs">{w.method}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-green-400 font-bold text-sm">৳{w.amount}</p>
                      <span className={`text-xs ${w.status === 'pending' ? 'text-yellow-500' : w.status === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                        {w.status === 'pending' ? '⏳' : w.status === 'success' ? '✅' : '❌'} {w.status}
                      </span>
                    </div>
                  </div>
                  {w.adminNote && <div className="mt-2 px-3 py-2 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)' }}><p className="text-gray-400 text-xs">📝 {w.adminNote}</p></div>}
                </div>
              ))}
              <div className="my-4 border-t border-white/5" />
            </>}

            <p className="text-gray-700 text-xs uppercase tracking-widest mb-3">Coin Activity</p>
            {coinHistory.length === 0
              ? <div className="text-center py-10 text-gray-700 text-sm">কোনো activity নেই</div>
              : coinHistory.map(h => (
                <div key={h.id} className="flex items-center gap-3 py-3 border-b border-white/5">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-sm flex-shrink-0 ${h.type === 'earn' ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
                    {h.type === 'earn' ? '↑' : '↓'}
                  </div>
                  <p className="text-gray-300 text-sm flex-1">{h.reason}</p>
                  <span className={`font-bold text-sm ${h.type === 'earn' ? 'text-green-400' : 'text-red-400'}`}>
                    {h.type === 'earn' ? '+' : '-'}{h.amount}
                  </span>
                </div>
              ))}
          </motion.div>
        )}

      </AnimatePresence>
    </motion.div>
  );
};

export default UserProfile;
