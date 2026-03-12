import { Component } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="max-w-lg mx-auto px-4 pt-16 pb-24 text-center">
          <div className="bg-oracle-card border border-oracle-border rounded-2xl p-8">
            <div className="w-16 h-16 rounded-full bg-oracle-red/15 border border-oracle-red/30 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle size={28} className="text-oracle-red" />
            </div>
            <h2 className="text-oracle-text font-bold text-lg mb-2">Something went wrong</h2>
            <p className="text-oracle-muted text-sm mb-5 leading-relaxed">
              An unexpected error occurred. This usually fixes itself on reload.
            </p>
            {this.state.error?.message && (
              <p className="text-oracle-muted/60 text-xs font-mono bg-oracle-bg rounded-lg p-3 mb-5 break-all">
                {this.state.error.message}
              </p>
            )}
            <button
              onClick={this.handleReset}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-oracle-accent text-white text-sm font-medium rounded-xl hover:bg-oracle-accent/80 transition-colors active:scale-95"
            >
              <RotateCcw size={14} />
              Try Again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
