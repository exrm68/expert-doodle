import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  User, Copy, CheckCheck, Coins, TrendingUp, 
  ArrowRight, Gift, Users, Wallet, Clock, 
  ChevronRight, X, AlertCircle, CheckCircle2,
  Banknote, Send, History, LogOut, Star
} from 'lucide-react';
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
          user?: {
            id: number;
            first_name: string;
            last_name?: string;
            username?: string;
            photo_url?: string;
          };
          start_param?: string;
        };
        openTelegramLink?: (url: string) => void;
        openLink?: (url: string) => void;
      };
    };
  }
}

interface UserData {
  telegramId: string;
  name: string;
  username?: string;
  photo?: string;
  coins: number;
  takaBalance: number;
  referralCode: string;
  referredBy?: string;
  referralCount: number;
  joinedAt: any;
  lastLogin: any;
  milestonesClaimed: number[];
  unlockedMovies?: string[];
}

interface WithdrawalRequest {
  id?: string;
  userId: string;
  userName: string;
  amount: number;
  method: 'bkash' | 'nagad';
  number: string;
  status: 'pending' | 'success' | 'cancelled';
  adminNote?: string;
  createdAt: any;
}

interface CoinHistory {
  id?: string;
  type: 'earn' | 'spend';
  reason: string;
  amount: number;
  createdAt: any;
}

interface UserProfileProps {
  onClose: () => void;
  botUsername: string;
}

const MILESTONES = [
  { count: 5, bonus: 50 },
  { count: 10, bonus: 150 },
  { count: 20, bonus: 400 },
  { count: 50, bonus: 1000 },
];

const COIN_TO_TAKA_RATE = 100; // 1000 coin = 10 taka, so 100 coin = 1 taka
const MIN_WITHDRAW_TAKA = 50;

const UserProfile: React.FC<UserProfileProps> = ({ onClose, botUsername }) => {
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'profile' | 'earn' | 'wallet' | 'history'>('profile');
  const [copied, setCopied] = useState(false);
  const [withdrawModal, setWithdrawModal] = useState(false);
  const [withdrawMethod, setWithdrawMethod] = useState<'bkash' | 'nagad'>('bkash');
  const [withdrawNumber, setWithdrawNumber] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [coinHistory, setCoinHistory] = useState<CoinHistory[]>([]);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [convertModal, setConvertModal] = useState(false);
  const [convertAmount, setConvertAmount] = useState('');
  const [convertLoading, setConvertLoading] = useState(false);

  const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param || 
                     (window.Telegram?.WebApp as any)?.initDataUnsafe?.startParam || '';

  // Load bot username from Firebase appSettings
  const [actualBotUsername, setActualBotUsername] = useState(botUsername || '');

  useEffect(() => {
    const loadBotUsername = async () => {
      try {
        const snap = await getDoc(doc(db, 'settings', 'app'));
        if (snap.exists() && snap.data().botUsername) {
          setActualBotUsername(snap.data().botUsername);
        }
      } catch (e) {}
    };
    loadBotUsername();
  }, []);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Initialize user
  useEffect(() => {
    if (!tgUser) {
      setLoading(false);
      return;
    }
    initUser();
  }, []);

  const initUser = async () => {
    if (!tgUser) return;
    const userId = String(tgUser.id);
    const userRef = doc(db, 'users', userId);
    
    try {
      const snap = await getDoc(userRef);
      
      if (!snap.exists()) {
        // New user
        const referralCode = `CIN${userId.slice(-6)}`;
        const newUser: UserData = {
          telegramId: userId,
          name: `${tgUser.first_name}${tgUser.last_name ? ' ' + tgUser.last_name : ''}`,
          username: tgUser.username,
          photo: tgUser.photo_url,
          coins: 50, // Welcome bonus
          takaBalance: 0,
          referralCode,
          referralCount: 0,
          joinedAt: serverTimestamp(),
          lastLogin: serverTimestamp(),
          milestonesClaimed: [],
          unlockedMovies: [],
        };
        
        await setDoc(userRef, newUser);
        
        // Log welcome coin
        await addCoinHistory(userId, 'earn', 'স্বাগত বোনাস 🎉', 50);
        
        // Handle referral
        if (startParam && startParam.startsWith('ref_')) {
          const refCode = startParam.replace('ref_', '');
          await handleReferral(userId, refCode);
        }
        
        setUserData({ ...newUser, joinedAt: new Date(), lastLogin: new Date() });
      } else {
        // Existing user - daily login
        const data = snap.data() as UserData;
        const lastLogin = data.lastLogin?.toDate?.() || new Date(0);
        const now = new Date();
        const isNewDay = now.toDateString() !== lastLogin.toDateString();
        
        if (isNewDay) {
          await updateDoc(userRef, { 
            coins: increment(5), 
            lastLogin: serverTimestamp() 
          });
          await addCoinHistory(userId, 'earn', 'Daily Login বোনাস', 5);
          showToast('Daily Login! +5 Coin 🪙');
        } else {
          await updateDoc(userRef, { lastLogin: serverTimestamp() });
        }
        
        setUserData(data);
      }
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  // Real-time user data
  useEffect(() => {
    if (!tgUser) return;
    const userId = String(tgUser.id);
    const unsub = onSnapshot(doc(db, 'users', userId), (snap) => {
      if (snap.exists()) setUserData(snap.data() as UserData);
    });
    return () => unsub();
  }, [tgUser]);

  // Load withdrawals
  useEffect(() => {
    if (!tgUser) return;
    const userId = String(tgUser.id);
    const q = query(
      collection(db, 'withdrawals'), 
      where('userId', '==', userId),
      orderBy('createdAt', 'desc'),
      limit(10)
    );
    const unsub = onSnapshot(q, (snap) => {
      setWithdrawals(snap.docs.map(d => ({ id: d.id, ...d.data() } as WithdrawalRequest)));
    });
    return () => unsub();
  }, [tgUser]);

  // Load coin history
  useEffect(() => {
    if (!tgUser) return;
    const userId = String(tgUser.id);
    const q = query(
      collection(db, `users/${userId}/coinHistory`),
      orderBy('createdAt', 'desc'),
      limit(20)
    );
    const unsub = onSnapshot(q, (snap) => {
      setCoinHistory(snap.docs.map(d => ({ id: d.id, ...d.data() } as CoinHistory)));
    });
    return () => unsub();
  }, [tgUser]);

  const addCoinHistory = async (userId: string, type: 'earn' | 'spend', reason: string, amount: number) => {
    await addDoc(collection(db, `users/${userId}/coinHistory`), {
      type, reason, amount, createdAt: serverTimestamp()
    });
  };

  const handleReferral = async (newUserId: string, refCode: string) => {
    try {
      // Find referrer
      const q = query(collection(db, 'users'), where('referralCode', '==', refCode), limit(1));
      const snap = await getDocs(q);
      if (snap.empty) return;
      
      const referrerDoc = snap.docs[0];
      const referrerId = referrerDoc.id;
      
      if (referrerId === newUserId) return; // নিজেকে refer করতে পারবে না
      
      // Check if already referred
      const newUserRef = doc(db, 'users', newUserId);
      const newUserSnap = await getDoc(newUserRef);
      if (newUserSnap.data()?.referredBy) return;
      
      // Update new user
      await updateDoc(newUserRef, { referredBy: referrerId });
      
      // Update referrer (first video click এ coin দেওয়া হবে, এখন pending রাখি)
      await addDoc(collection(db, 'pendingReferrals'), {
        referrerId,
        newUserId,
        completed: false,
        createdAt: serverTimestamp()
      });
      
    } catch (err) {
      console.error(err);
    }
  };

  // Complete referral when user clicks video
  const completeReferral = async () => {
    if (!tgUser) return;
    const userId = String(tgUser.id);
    
    try {
      const q = query(
        collection(db, 'pendingReferrals'),
        where('newUserId', '==', userId),
        where('completed', '==', false),
        limit(1)
      );
      const snap = await getDocs(q);
      if (snap.empty) return;
      
      const pendingRef = snap.docs[0];
      const { referrerId } = pendingRef.data();
      
      // Mark completed
      await updateDoc(doc(db, 'pendingReferrals', pendingRef.id), { completed: true });
      
      // Give referrer 100 coins
      const referrerRef = doc(db, 'users', referrerId);
      const referrerSnap = await getDoc(referrerRef);
      if (!referrerSnap.exists()) return;
      
      const referrerData = referrerSnap.data() as UserData;
      const newCount = (referrerData.referralCount || 0) + 1;
      
      await updateDoc(referrerRef, { 
        coins: increment(100),
        referralCount: increment(1)
      });
      await addCoinHistory(referrerId, 'earn', `Referral Coin - ${userData?.name || 'নতুন বন্ধু'}`, 100);
      
      // Check milestones
      for (const milestone of MILESTONES) {
        if (newCount >= milestone.count && !referrerData.milestonesClaimed?.includes(milestone.count)) {
          await updateDoc(referrerRef, {
            coins: increment(milestone.bonus),
            milestonesClaimed: [...(referrerData.milestonesClaimed || []), milestone.count]
          });
          await addCoinHistory(referrerId, 'earn', `🎯 ${milestone.count} Refer Milestone Bonus!`, milestone.bonus);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Expose for video click
  useEffect(() => {
    (window as any).completeCinelixReferral = completeReferral;
  }, [tgUser, userData]);

  const getReferralLink = () => {
    if (!userData?.referralCode) return '';
    const bot = actualBotUsername || botUsername || 'YourBot';
    return `https://t.me/${bot}?startapp=ref_${userData.referralCode}`;
  };

  const copyReferral = async () => {
    const link = getReferralLink();
    if (!link) { showToast('একটু অপেক্ষা করো...', 'error'); return; }
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    showToast('Referral link copied! 🔗');
  };

  const shareReferral = () => {
    const link = getReferralLink();
    if (!link) { showToast('একটু অপেক্ষা করো...', 'error'); return; }
    const text = `🎬 *CineFlix* - বাংলাদেশের সেরা Movie App!\n\n🪙 Join করলেই পাবে *50 Coin* বোনাস!\n💰 Refer করে আয় করো!\n\n👇 এখনই Join করো:\n${link}`;
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    window.Telegram?.WebApp?.openTelegramLink?.(url);
  };

  const handleWithdraw = async () => {
    if (!userData || !tgUser) return;
    const amount = parseFloat(withdrawAmount);
    
    if (!withdrawNumber || withdrawNumber.length < 11) {
      showToast('সঠিক নম্বর দাও!', 'error'); return;
    }
    if (isNaN(amount) || amount < MIN_WITHDRAW_TAKA) {
      showToast(`Minimum ${MIN_WITHDRAW_TAKA} taka withdraw করতে পারবে!`, 'error'); return;
    }
    if (amount > userData.takaBalance) {
      showToast('Balance কম!', 'error'); return;
    }
    
    setWithdrawLoading(true);
    try {
      const userId = String(tgUser.id);
      await addDoc(collection(db, 'withdrawals'), {
        userId,
        userName: userData.name,
        amount,
        method: withdrawMethod,
        number: withdrawNumber,
        status: 'pending',
        adminNote: '',
        createdAt: serverTimestamp()
      });
      
      await updateDoc(doc(db, 'users', userId), {
        takaBalance: increment(-amount)
      });
      
      setWithdrawModal(false);
      setWithdrawNumber('');
      setWithdrawAmount('');
      showToast('Withdrawal request পাঠানো হয়েছে! ✅');
    } catch (err) {
      showToast('Error! আবার try করো', 'error');
    }
    setWithdrawLoading(false);
  };

  const handleConvert = async () => {
    if (!userData || !tgUser) return;
    const coins = parseInt(convertAmount);
    
    if (isNaN(coins) || coins < 500) {
      showToast('Minimum 500 coin convert করতে পারবে!', 'error'); return;
    }
    if (coins > userData.coins) {
      showToast('Coin কম!', 'error'); return;
    }
    if (coins % 500 !== 0) {
      showToast('500 এর গুণিতক দাও (500, 1000, 1500...)', 'error'); return;
    }
    
    const taka = (coins / 1000) * 10;
    setConvertLoading(true);
    try {
      const userId = String(tgUser.id);
      await updateDoc(doc(db, 'users', userId), {
        coins: increment(-coins),
        takaBalance: increment(taka)
      });
      await addCoinHistory(userId, 'spend', `${coins} Coin → ${taka} Taka Convert`, coins);
      setConvertModal(false);
      setConvertAmount('');
      showToast(`${coins} Coin → ${taka} Taka Convert হয়েছে! 💰`);
    } catch (err) {
      showToast('Error!', 'error');
    }
    setConvertLoading(false);
  };

  const formatTime = (ts: any) => {
    if (!ts) return '';
    const date = ts?.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleDateString('bn-BD', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  if (!tgUser) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
        <div className="text-center px-8">
          <div className="text-6xl mb-4">📱</div>
          <p className="text-white text-lg font-bold">Telegram Mini App</p>
          <p className="text-gray-400 text-sm mt-2">এই feature শুধু Telegram এ কাজ করে</p>
          <button onClick={onClose} className="mt-6 px-6 py-3 bg-gold text-black rounded-2xl font-bold">
            Back
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 bg-[#0a0a0a] flex items-center justify-center">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          className="w-12 h-12 border-2 border-gold/20 border-t-gold rounded-full"
        />
      </div>
    );
  }

  const coinsNeeded = userData ? Math.max(0, 5000 - userData.coins) : 0;
  const progressPercent = userData ? Math.min(100, (userData.coins / 5000) * 100) : 0;
  const canWithdraw = userData ? userData.takaBalance >= MIN_WITHDRAW_TAKA : false;
  const canConvert = userData ? userData.coins >= 500 : false;
  const nextMilestone = MILESTONES.find(m => (userData?.referralCount || 0) < m.count);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-[#0a0a0a] overflow-y-auto"
    >
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`fixed top-4 left-4 right-4 z-[60] flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl ${
              toast.type === 'success' ? 'bg-green-500/20 border border-green-500/30' : 'bg-red-500/20 border border-red-500/30'
            }`}
          >
            {toast.type === 'success' ? <CheckCircle2 size={18} className="text-green-400" /> : <AlertCircle size={18} className="text-red-400" />}
            <span className="text-white text-sm font-medium">{toast.msg}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="relative px-4 pt-6 pb-4">
        <button onClick={onClose} className="absolute top-6 right-4 w-9 h-9 bg-white/10 rounded-full flex items-center justify-center">
          <X size={18} className="text-white" />
        </button>
        
        {/* Profile Info */}
        <div className="flex items-center gap-4 mt-2">
          <div className="relative">
            {userData?.photo ? (
              <img src={userData.photo} alt="" className="w-16 h-16 rounded-2xl object-cover border-2 border-gold/30" />
            ) : (
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-gold/30 to-gold/10 flex items-center justify-center border-2 border-gold/30">
                <User size={28} className="text-gold" />
              </div>
            )}
            <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-green-500 rounded-full border-2 border-[#0a0a0a]" />
          </div>
          
          <div className="flex-1">
            <h2 className="text-white text-lg font-bold">{userData?.name}</h2>
            {userData?.username && <p className="text-gray-400 text-sm">@{userData.username}</p>}
            <div className="flex items-center gap-3 mt-1.5">
              <div className="flex items-center gap-1.5 bg-gold/10 px-3 py-1 rounded-full border border-gold/20">
                <span className="text-gold text-sm">🪙</span>
                <span className="text-gold text-sm font-bold">{userData?.coins?.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1.5 bg-green-500/10 px-3 py-1 rounded-full border border-green-500/20">
                <span className="text-green-400 text-sm">৳</span>
                <span className="text-green-400 text-sm font-bold">{userData?.takaBalance?.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Progress to withdrawal */}
        <div className="mt-4 bg-white/5 rounded-2xl p-4 border border-white/5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-400 text-xs">Withdrawal Progress</span>
            <span className="text-gold text-xs font-bold">{userData?.coins?.toLocaleString()} / 5000 🪙</span>
          </div>
          <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 1, ease: 'easeOut' }}
              className="h-full bg-gradient-to-r from-gold to-yellow-400 rounded-full"
            />
          </div>
          {coinsNeeded > 0 ? (
            <p className="text-gray-400 text-xs mt-2">
              আর মাত্র <span className="text-gold font-bold">{coinsNeeded}</span> coin = 50 taka withdraw করতে পারবে!
              <span className="text-white font-bold"> ({Math.ceil(coinsNeeded / 100)} জন refer করো)</span>
            </p>
          ) : (
            <p className="text-green-400 text-xs mt-2 font-bold">🎉 Withdraw করার যোগ্য!</p>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 px-4 mb-4 overflow-x-auto no-scrollbar">
        {[
          { id: 'profile', label: 'Profile', icon: User },
          { id: 'earn', label: 'Earn', icon: TrendingUp },
          { id: 'wallet', label: 'Wallet', icon: Wallet },
          { id: 'history', label: 'History', icon: History },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
              activeTab === tab.id 
                ? 'bg-gold text-black' 
                : 'bg-white/5 text-gray-400 border border-white/5'
            }`}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="px-4 pb-24">
        <AnimatePresence mode="wait">

          {/* PROFILE TAB */}
          {activeTab === 'profile' && (
            <motion.div key="profile" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              
              {/* Stats */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                {[
                  { label: 'Coins', value: userData?.coins?.toLocaleString() || '0', icon: '🪙', color: 'gold' },
                  { label: 'Refer', value: userData?.referralCount || 0, icon: '👥', color: 'blue-400' },
                  { label: 'Taka', value: `৳${userData?.takaBalance?.toFixed(0)}`, icon: '💰', color: 'green-400' },
                ].map(stat => (
                  <div key={stat.label} className="bg-white/5 rounded-2xl p-3 border border-white/5 text-center">
                    <div className="text-2xl mb-1">{stat.icon}</div>
                    <div className={`text-${stat.color} font-bold text-base`}>{stat.value}</div>
                    <div className="text-gray-500 text-xs">{stat.label}</div>
                  </div>
                ))}
              </div>

              {/* Referral Code */}
              <div className="bg-gradient-to-r from-gold/10 to-yellow-500/5 rounded-2xl p-4 border border-gold/20 mb-4">
                <p className="text-gray-400 text-xs mb-1">তোমার Referral Code</p>
                <p className="text-gold text-xl font-bold tracking-wider">{userData?.referralCode}</p>
                <p className="text-gray-400 text-xs mt-1">প্রতি সফল refer = 100 🪙</p>
              </div>

              {/* Refer Buttons */}
              <div className="flex gap-3 mb-4">
                <button
                  onClick={shareReferral}
                  className="flex-1 bg-gold text-black rounded-2xl py-3.5 flex items-center justify-center gap-2 font-bold text-sm"
                >
                  <Send size={16} />
                  Telegram Share
                </button>
                <button
                  onClick={copyReferral}
                  className="flex-1 bg-white/10 text-white rounded-2xl py-3.5 flex items-center justify-center gap-2 font-bold text-sm border border-white/10"
                >
                  {copied ? <CheckCheck size={16} className="text-green-400" /> : <Copy size={16} />}
                  {copied ? 'Copied!' : 'Link Copy'}
                </button>
              </div>

              {/* Next Milestone */}
              {nextMilestone && (
                <div className="bg-purple-500/10 rounded-2xl p-4 border border-purple-500/20 mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Star size={16} className="text-purple-400" />
                    <span className="text-purple-300 text-sm font-bold">পরের Milestone</span>
                  </div>
                  <p className="text-white text-sm">
                    আর <span className="text-gold font-bold">{nextMilestone.count - (userData?.referralCount || 0)} জন</span> refer করলে 
                    extra <span className="text-gold font-bold">{nextMilestone.bonus} coin</span> পাবে!
                  </p>
                  <div className="mt-2 w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-purple-400 rounded-full transition-all"
                      style={{ width: `${Math.min(100, ((userData?.referralCount || 0) / nextMilestone.count) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* EARN TAB */}
          {activeTab === 'earn' && (
            <motion.div key="earn" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              
              {/* How to earn */}
              <h3 className="text-white font-bold text-sm mb-3 flex items-center gap-2">
                <Gift size={16} className="text-gold" /> কিভাবে Coin আয় করবে
              </h3>
              
              {[
                { icon: '🎁', title: 'নতুন Join', desc: 'প্রথমবার app open করলে', coin: '+50', color: 'green' },
                { icon: '👥', title: 'Friend Refer', desc: 'বন্ধু প্রথম video click করলে', coin: '+100', color: 'gold' },
                { icon: '📅', title: 'Daily Login', desc: 'প্রতিদিন app open করলে', coin: '+5', color: 'blue' },
                { icon: '🎯', title: '5 Refer Milestone', desc: '5 জন refer complete হলে', coin: '+50', color: 'purple' },
                { icon: '⭐', title: '10 Refer Milestone', desc: '10 জন refer complete হলে', coin: '+150', color: 'purple' },
                { icon: '🏆', title: '20 Refer Milestone', desc: '20 জন refer complete হলে', coin: '+400', color: 'purple' },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3 bg-white/5 rounded-2xl p-4 border border-white/5 mb-3">
                  <div className="text-3xl">{item.icon}</div>
                  <div className="flex-1">
                    <p className="text-white text-sm font-bold">{item.title}</p>
                    <p className="text-gray-400 text-xs">{item.desc}</p>
                  </div>
                  <div className={`text-${item.color === 'gold' ? 'gold' : item.color + '-400'} font-bold text-sm bg-${item.color === 'gold' ? 'gold' : item.color + '-500'}/10 px-3 py-1 rounded-full`}>
                    {item.coin}
                  </div>
                </div>
              ))}

              {/* Coin to Taka Table */}
              <h3 className="text-white font-bold text-sm mb-3 mt-4 flex items-center gap-2">
                <Banknote size={16} className="text-green-400" /> Coin → Taka Conversion
              </h3>
              
              <div className="bg-white/5 rounded-2xl border border-white/5 overflow-hidden mb-4">
                {[
                  { coin: 500, taka: 5, unlock: false },
                  { coin: 1000, taka: 10, unlock: false },
                  { coin: 2000, taka: 20, unlock: false },
                  { coin: 5000, taka: 50, unlock: true },
                ].map((row, i) => {
                  const hasEnough = (userData?.coins || 0) >= row.coin;
                  return (
                    <div key={i} className={`flex items-center justify-between px-4 py-3 ${i < 3 ? 'border-b border-white/5' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-bold ${hasEnough ? 'text-gold' : 'text-gray-500'}`}>
                          🪙 {row.coin.toLocaleString()} Coin
                        </span>
                      </div>
                      <ArrowRight size={14} className="text-gray-600" />
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-bold ${hasEnough ? 'text-green-400' : 'text-gray-500'}`}>
                          ৳ {row.taka} Taka
                        </span>
                        {row.unlock && <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full">Withdraw</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Convert button */}
              <button
                onClick={() => canConvert ? setConvertModal(true) : showToast('Minimum 500 coin দরকার!', 'error')}
                className={`w-full py-4 rounded-2xl font-bold text-sm flex items-center justify-center gap-2 transition-all ${
                  canConvert 
                    ? 'bg-gradient-to-r from-gold to-yellow-400 text-black' 
                    : 'bg-white/5 text-gray-500 border border-white/5'
                }`}
              >
                <Coins size={18} />
                {canConvert ? 'Coin → Taka Convert করো' : `আরো ${500 - (userData?.coins || 0)} coin দরকার`}
              </button>
            </motion.div>
          )}

          {/* WALLET TAB */}
          {activeTab === 'wallet' && (
            <motion.div key="wallet" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              
              {/* Balance Card */}
              <div className="bg-gradient-to-br from-green-500/20 to-emerald-600/10 rounded-3xl p-6 border border-green-500/20 mb-4">
                <p className="text-gray-400 text-xs mb-1">Total Balance</p>
                <p className="text-white text-4xl font-bold">৳ {userData?.takaBalance?.toFixed(2)}</p>
                <p className="text-gray-400 text-xs mt-1">🪙 {userData?.coins?.toLocaleString()} Coin available</p>
              </div>

              {/* Withdraw Button */}
              <button
                onClick={() => canWithdraw ? setWithdrawModal(true) : showToast(`Minimum ৳${MIN_WITHDRAW_TAKA} দরকার! আরো ${MIN_WITHDRAW_TAKA - (userData?.takaBalance || 0)} taka দরকার`, 'error')}
                className={`w-full py-4 rounded-2xl font-bold text-sm flex items-center justify-center gap-2 mb-4 transition-all ${
                  canWithdraw 
                    ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white shadow-lg shadow-green-500/20' 
                    : 'bg-white/5 text-gray-500 border border-white/5'
                }`}
              >
                <Banknote size={18} />
                {canWithdraw ? 'Withdrawal Request করো' : `আরো ৳${(MIN_WITHDRAW_TAKA - (userData?.takaBalance || 0)).toFixed(0)} দরকার`}
              </button>

              {/* Withdrawal History */}
              <h3 className="text-white font-bold text-sm mb-3 flex items-center gap-2">
                <Clock size={16} className="text-gray-400" /> Withdrawal History
              </h3>

              {withdrawals.length === 0 ? (
                <div className="text-center py-10">
                  <div className="text-4xl mb-3">💸</div>
                  <p className="text-gray-500 text-sm">এখনো কোনো withdrawal নেই</p>
                </div>
              ) : (
                withdrawals.map(w => (
                  <div key={w.id} className="bg-white/5 rounded-2xl p-4 border border-white/5 mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {w.method === 'bkash' ? (
                          <div className="w-8 h-8 bg-[#E2136E] rounded-xl flex items-center justify-center text-white text-xs font-black">B</div>
                        ) : (
                          <div className="w-8 h-8 bg-[#F15A22] rounded-xl flex items-center justify-center text-white text-xs font-black">N</div>
                        )}
                        <div>
                          <p className="text-white text-sm font-bold">{w.method === 'bkash' ? 'bKash' : 'Nagad'}</p>
                          <p className="text-gray-400 text-xs">{w.number}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-green-400 font-bold">৳{w.amount}</p>
                        <div className={`text-xs px-2 py-0.5 rounded-full mt-1 ${
                          w.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400' :
                          w.status === 'success' ? 'bg-green-500/20 text-green-400' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {w.status === 'pending' ? '⏳ Pending' : w.status === 'success' ? '✅ Success' : '❌ Cancelled'}
                        </div>
                      </div>
                    </div>
                    {w.adminNote && (
                      <div className="bg-white/5 rounded-xl px-3 py-2 mt-2">
                        <p className="text-gray-400 text-xs">📝 {w.adminNote}</p>
                      </div>
                    )}
                    <p className="text-gray-600 text-xs mt-2">{formatTime(w.createdAt)}</p>
                  </div>
                ))
              )}
            </motion.div>
          )}

          {/* HISTORY TAB */}
          {activeTab === 'history' && (
            <motion.div key="history" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <h3 className="text-white font-bold text-sm mb-3 flex items-center gap-2">
                <History size={16} className="text-gold" /> Coin History
              </h3>
              
              {coinHistory.length === 0 ? (
                <div className="text-center py-10">
                  <div className="text-4xl mb-3">📊</div>
                  <p className="text-gray-500 text-sm">কোনো history নেই</p>
                </div>
              ) : (
                coinHistory.map(h => (
                  <div key={h.id} className="flex items-center gap-3 bg-white/5 rounded-2xl p-3.5 border border-white/5 mb-2.5">
                    <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-lg ${
                      h.type === 'earn' ? 'bg-green-500/10' : 'bg-red-500/10'
                    }`}>
                      {h.type === 'earn' ? '📈' : '📉'}
                    </div>
                    <div className="flex-1">
                      <p className="text-white text-sm font-medium">{h.reason}</p>
                      <p className="text-gray-500 text-xs">{formatTime(h.createdAt)}</p>
                    </div>
                    <span className={`font-bold text-sm ${h.type === 'earn' ? 'text-green-400' : 'text-red-400'}`}>
                      {h.type === 'earn' ? '+' : '-'}{h.amount} 🪙
                    </span>
                  </div>
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Convert Modal */}
      <AnimatePresence>
        {convertModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-end"
            onClick={e => e.target === e.currentTarget && setConvertModal(false)}
          >
            <motion.div
              initial={{ y: 100 }}
              animate={{ y: 0 }}
              exit={{ y: 100 }}
              className="w-full bg-[#111] rounded-t-3xl p-6 border-t border-white/10"
            >
              <h3 className="text-white font-bold text-lg mb-1">Coin → Taka Convert</h3>
              <p className="text-gray-400 text-xs mb-4">1000 Coin = 10 Taka • Minimum 500 Coin</p>
              
              <div className="bg-white/5 rounded-2xl p-4 border border-white/5 mb-4">
                <p className="text-gray-400 text-xs mb-1">Available Coins</p>
                <p className="text-gold text-2xl font-bold">🪙 {userData?.coins?.toLocaleString()}</p>
              </div>
              
              <input
                type="number"
                placeholder="কত Coin convert করবে? (500, 1000, 1500...)"
                value={convertAmount}
                onChange={e => setConvertAmount(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-4 text-white text-sm mb-2 outline-none focus:border-gold/50"
              />
              
              {convertAmount && parseInt(convertAmount) >= 500 && (
                <p className="text-green-400 text-sm text-center mb-4">
                  = ৳ {((parseInt(convertAmount) / 1000) * 10).toFixed(2)} Taka
                </p>
              )}
              
              <div className="flex gap-3">
                <button onClick={() => setConvertModal(false)} className="flex-1 py-4 bg-white/10 text-white rounded-2xl font-bold">Cancel</button>
                <button
                  onClick={handleConvert}
                  disabled={convertLoading}
                  className="flex-1 py-4 bg-gold text-black rounded-2xl font-bold flex items-center justify-center gap-2"
                >
                  {convertLoading ? <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity }} className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full" /> : 'Convert করো'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Withdraw Modal */}
      <AnimatePresence>
        {withdrawModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-end"
            onClick={e => e.target === e.currentTarget && setWithdrawModal(false)}
          >
            <motion.div
              initial={{ y: 100 }}
              animate={{ y: 0 }}
              exit={{ y: 100 }}
              className="w-full bg-[#111] rounded-t-3xl p-6 border-t border-white/10"
            >
              <h3 className="text-white font-bold text-lg mb-1">Withdrawal Request</h3>
              <p className="text-gray-400 text-xs mb-5">Balance: ৳{userData?.takaBalance?.toFixed(2)} • Minimum ৳{MIN_WITHDRAW_TAKA}</p>
              
              {/* Method Select */}
              <div className="flex gap-3 mb-5">
                <button
                  onClick={() => setWithdrawMethod('bkash')}
                  className={`flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl border-2 transition-all ${
                    withdrawMethod === 'bkash' ? 'border-[#E2136E] bg-[#E2136E]/10' : 'border-white/10 bg-white/5'
                  }`}
                >
                  <div className="w-8 h-8 bg-[#E2136E] rounded-xl flex items-center justify-center text-white font-black text-sm">B</div>
                  <span className="text-white font-bold text-sm">bKash</span>
                </button>
                <button
                  onClick={() => setWithdrawMethod('nagad')}
                  className={`flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl border-2 transition-all ${
                    withdrawMethod === 'nagad' ? 'border-[#F15A22] bg-[#F15A22]/10' : 'border-white/10 bg-white/5'
                  }`}
                >
                  <div className="w-8 h-8 bg-[#F15A22] rounded-xl flex items-center justify-center text-white font-black text-sm">N</div>
                  <span className="text-white font-bold text-sm">Nagad</span>
                </button>
              </div>
              
              {/* Number Input */}
              <div className="relative mb-3">
                <div className={`absolute left-4 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg flex items-center justify-center text-white font-black text-xs ${
                  withdrawMethod === 'bkash' ? 'bg-[#E2136E]' : 'bg-[#F15A22]'
                }`}>
                  {withdrawMethod === 'bkash' ? 'B' : 'N'}
                </div>
                <input
                  type="tel"
                  placeholder={`${withdrawMethod === 'bkash' ? 'bKash' : 'Nagad'} নম্বর (01XXXXXXXXX)`}
                  value={withdrawNumber}
                  onChange={e => setWithdrawNumber(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl pl-14 pr-4 py-4 text-white text-sm outline-none focus:border-gold/50"
                />
              </div>

              {withdrawNumber.length === 11 && (
                <motion.div 
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 bg-white/5 rounded-xl px-4 py-3 mb-3 border border-white/5"
                >
                  <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-white font-black text-xs ${withdrawMethod === 'bkash' ? 'bg-[#E2136E]' : 'bg-[#F15A22]'}`}>
                    {withdrawMethod === 'bkash' ? 'B' : 'N'}
                  </div>
                  <span className="text-white text-sm">{withdrawNumber}</span>
                  <CheckCircle2 size={16} className="text-green-400 ml-auto" />
                </motion.div>
              )}
              
              {/* Amount */}
              <input
                type="number"
                placeholder={`পরিমাণ (Minimum ৳${MIN_WITHDRAW_TAKA})`}
                value={withdrawAmount}
                onChange={e => setWithdrawAmount(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-4 text-white text-sm mb-5 outline-none focus:border-gold/50"
              />
              
              <div className="flex gap-3">
                <button onClick={() => setWithdrawModal(false)} className="flex-1 py-4 bg-white/10 text-white rounded-2xl font-bold">Cancel</button>
                <button
                  onClick={handleWithdraw}
                  disabled={withdrawLoading}
                  className="flex-1 py-4 bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-2xl font-bold flex items-center justify-center gap-2"
                >
                  {withdrawLoading ? <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity }} className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full" /> : '✅ Request পাঠাও'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </motion.div>
  );
};

export default UserProfile;
