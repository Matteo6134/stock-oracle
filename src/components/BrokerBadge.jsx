import { CheckCircle, XCircle } from 'lucide-react'

export default function BrokerBadge({ name, available }) {
  if (available) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-oracle-green/15 text-oracle-green border border-oracle-green/30">
        <CheckCircle size={10} />
        {name}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-oracle-muted/15 text-oracle-muted border border-oracle-muted/30">
      <XCircle size={10} />
      {name}
    </span>
  )
}
