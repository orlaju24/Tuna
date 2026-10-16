import { useState } from "react";
import { ChevronDown, ChevronUp, X, Plus } from "lucide-react";
import { useFavorites, useAddFavorite, useDeleteFavorite } from "@/hooks/useFavorites";
import { usePrice } from "@/hooks/usePrice";
import { cn } from "@/lib/utils";

function FavItem({
  symbol,
  selected,
  onSelect,
  onDelete,
}: {
  symbol: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const price = usePrice(symbol);
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer select-none min-w-[110px] border transition-colors",
        selected
          ? "bg-blue-600 border-blue-500 text-white"
          : "bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700"
      )}
      onClick={onSelect}
    >
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold truncate">{symbol}</div>
        <div className="text-xs font-mono">
          {price !== null ? price.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
        </div>
      </div>
      <button
        className="opacity-50 hover:opacity-100 text-xs shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function FavoritesStrip({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (s: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const { data: favorites = [], isLoading } = useFavorites();
  const addFav = useAddFavorite();
  const delFav = useDeleteFavorite();

  const handleAdd = () => {
    const sym = input.trim().toUpperCase();
    if (!sym) return;
    addFav.mutate({ symbol: sym, sortOrder: favorites.length });
    setInput("");
    setAdding(false);
  };

  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Favorites</span>
        <button
          className="text-zinc-500 hover:text-zinc-300 p-1"
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {!collapsed && (
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
          {isLoading ? (
            <div className="text-xs text-zinc-500 py-2">Loading…</div>
          ) : (
            <>
              {favorites.map((f) => (
                <FavItem
                  key={f.id}
                  symbol={f.symbol}
                  selected={f.symbol === selected}
                  onSelect={() => onSelect(f.symbol)}
                  onDelete={() => delFav.mutate(f.id)}
                />
              ))}
              {adding ? (
                <div className="flex items-center gap-1 min-w-[140px]">
                  <input
                    autoFocus
                    className="bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs text-white w-24 uppercase placeholder-zinc-500"
                    placeholder="BTCUSDT"
                    value={input}
                    onChange={(e) => setInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                      if (e.key === "Escape") setAdding(false);
                    }}
                  />
                  <button
                    className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded"
                    onClick={handleAdd}
                  >
                    Add
                  </button>
                  <button
                    className="text-xs text-zinc-500 hover:text-white px-1"
                    onClick={() => setAdding(false)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <button
                  className="flex items-center gap-1 px-3 py-2 rounded-lg border border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 text-xs min-w-[80px]"
                  onClick={() => setAdding(true)}
                >
                  <Plus size={12} /> Add
                </button>
              )}
            </>
          )}
        </div>
      )}
      {collapsed && (
        <div className="text-xs text-zinc-300 font-semibold">{selected || "—"}</div>
      )}
    </div>
  );
}
