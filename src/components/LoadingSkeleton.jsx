export default function LoadingSkeleton({ count = 10 }) {
  return (
    <div className="space-y-3 px-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="glass-card p-4"
        >
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <div className="skeleton-shimmer h-5 w-16 rounded" />
                <div className="skeleton-shimmer h-4 w-32 rounded" />
              </div>
              <div className="flex items-center gap-2 mb-3">
                <div className="skeleton-shimmer h-5 w-14 rounded-full" />
                <div className="skeleton-shimmer h-4 w-20 rounded" />
              </div>
              <div className="flex gap-1">
                <div className="skeleton-shimmer h-1.5 w-full rounded-full" />
              </div>
            </div>
            <div className="flex flex-col items-end gap-2 ml-4">
              <div className="skeleton-shimmer h-10 w-10 rounded-full" />
              <div className="skeleton-shimmer h-4 w-16 rounded" />
              <div className="skeleton-shimmer h-4 w-12 rounded" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
