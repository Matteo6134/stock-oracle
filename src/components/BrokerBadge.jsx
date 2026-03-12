import { MarketIcon } from 'lucide-react' // Note: MarketIcon is not real, using ExternalLink or similar
import { ExternalLink, CheckCircle } from 'lucide-react'

export default function BrokerBadge({ name, available, url }) {
  if (available) {
    return (
      <a 
        href={url} 
        target="_blank" 
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-oracle-green/15 text-oracle-green border border-oracle-green/30 hover:bg-oracle-green/25 transition-colors"
      >
        <CheckCircle size={10} />
        {name}
      </a>
    )
  }

  return (
    <a 
      href={url} 
      target="_blank" 
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-oracle-muted/10 text-oracle-muted border border-oracle-muted/20 hover:bg-oracle-muted/20 transition-colors"
    >
      <ExternalLink size={10} />
      Check {name}
    </a>
  )
}
