import { useState, useRef } from "react";
import { FavoritesStrip } from "@/components/FavoritesStrip";
import { PairSummaryCard } from "@/components/PairSummaryCard";
import { AccountCard } from "@/components/AccountCard";
import { PositionCard } from "@/components/PositionCard";
import { LeverageControl } from "@/components/LeverageControl";
import { TradeActions } from "@/components/TradeActions";
import { TriggerPanel } from "@/components/TriggerPanel";
import { OpenPositionSafeguards } from "@/components/OpenPositionSafeguards";
import { PreTradePlanCard } from "@/components/PreTradePlanCard";
import { AutoEntryCard } from "@/components/AutoEntryCard";
import { OracleScoreCard } from "@/components/EdgeScoreCard";
import { SignalAwareness } from "@/components/SignalAwareness";
import { EventLog } from "@/components/EventLog";
import { TradeJournal } from "@/components/TradeJournal";
import { WalletGrowthCard } from "@/components/WalletGrowthCard";
import { PatternLibrary } from "@/components/PatternLibrary";
import { OracleLearning } from "@/components/OracleLearning";
import { BehaviorGovernor } from "@/components/BehaviorGovernor";
import { ResumptionCard } from "@/components/ResumptionCard";
import { AppStateProvider } from "@/hooks/useAppState";
import { type Position } from "@/hooks/usePositions";

const DEFAULT_SYMBOL = "BTCUSDT";

function DashboardContent({
  symbol,
  onSymbolChange,
}: {
  symbol: string;
  onSymbolChange: (s: string) => void;
}) {
  const [position, setPosition] = useState<Position | null>(null);
  const positionRef = useRef<Position | null>(null);

  const handlePosition = (p: Position | null) => {
    if (JSON.stringify(p) !== JSON.stringify(positionRef.current)) {
      positionRef.current = p;
      setPosition(p);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col">
      {/* Header */}
      <div className="bg-zinc-900 border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-sm font-bold tracking-tight">Bitunix Control</span>
        </div>
        <span className="text-xs text-zinc-500 font-mono">{symbol}</span>
      </div>

      {/* Favorites */}
      <FavoritesStrip selected={symbol} onSelect={onSymbolChange} />

      {/* Main scroll area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-3 py-4 space-y-3">
          <PairSummaryCard symbol={symbol} position={position} />
          <SignalAwareness symbol={symbol} position={position} />
          <OracleScoreCard symbol={symbol} />
          <ResumptionCard symbol={symbol} />
          <AccountCard />
          <PositionCard symbol={symbol} onPosition={handlePosition} />
          <LeverageControl symbol={symbol} />
          <TradeActions symbol={symbol} position={position} />
          <TriggerPanel symbol={symbol} />
          <AutoEntryCard />
          <PreTradePlanCard symbol={symbol} position={position} />
          <OpenPositionSafeguards selectedSymbol={symbol} selectedPosition={position} />
          <BehaviorGovernor />
          <EventLog />
          <WalletGrowthCard symbol={symbol} />
          <OracleLearning symbol={symbol} />
          <TradeJournal symbol={symbol} />
          <PatternLibrary symbol={symbol} />
          <div className="h-6" />
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);

  return (
    <AppStateProvider symbol={symbol}>
      <DashboardContent symbol={symbol} onSymbolChange={setSymbol} />
    </AppStateProvider>
  );
}
