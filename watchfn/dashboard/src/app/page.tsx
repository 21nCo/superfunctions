export default function Home() {
  return (
    <main className="min-h-screen p-8">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight text-white">WatchFn</h1>
        <div className="flex gap-4">
            <button className="bg-blue-600 px-4 py-2 rounded text-sm font-medium hover:bg-blue-500 transition-colors">Last 1h</button>
        </div>
      </header>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-6 rounded-lg bg-slate-900 border border-slate-800 shadow-sm">
            <h3 className="text-slate-400 font-medium mb-2 text-sm uppercase tracking-wider">Request Rate</h3>
            <div className="text-3xl font-bold text-white">1,245 <span className="text-sm text-slate-500 font-normal">rpm</span></div>
        </div>
        <div className="p-6 rounded-lg bg-slate-900 border border-slate-800 shadow-sm">
            <h3 className="text-slate-400 font-medium mb-2 text-sm uppercase tracking-wider">Error Rate</h3>
            <div className="text-3xl font-bold text-red-400">0.12%</div>
        </div>
        <div className="p-6 rounded-lg bg-slate-900 border border-slate-800 shadow-sm">
            <h3 className="text-slate-400 font-medium mb-2 text-sm uppercase tracking-wider">P95 Latency</h3>
            <div className="text-3xl font-bold text-yellow-400">145ms</div>
        </div>
      </div>
      
      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 p-6 rounded-lg bg-slate-900 border border-slate-800 h-96 flex flex-col">
              <h3 className="text-slate-400 font-medium mb-4">Traffic Overview</h3>
              <div className="flex-1 flex items-center justify-center text-slate-600 border-2 border-dashed border-slate-800 rounded">
                  Chart Component Placeholder
              </div>
          </div>
          <div className="p-6 rounded-lg bg-slate-900 border border-slate-800 h-96 flex flex-col">
              <h3 className="text-slate-400 font-medium mb-4">Top Endpoints</h3>
              <div className="flex-1 space-y-4">
                  {[1,2,3,4,5].map(i => (
                      <div key={i} className="flex justify-between items-center text-sm">
                          <span className="text-slate-300 font-mono">/api/v1/users</span>
                          <span className="text-slate-500">24ms</span>
                      </div>
                  ))}
              </div>
          </div>
      </div>
    </main>
  )
}
