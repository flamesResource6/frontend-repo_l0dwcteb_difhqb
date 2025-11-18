import React, { useEffect, useMemo, useRef, useState } from 'react'
import Spline from '@splinetool/react-spline'
import { Play, Pause, Download, History, Volume2, Music2, Wand2, Globe, Radio, KeyRound, LinkIcon, Loader2 } from 'lucide-react'

const MODELS = ['V3_5','V4','V4_5','V4_5PLUS','V5']

function useSessionKey() {
  const [key, setKey] = useState(() => sessionStorage.getItem('SUNO_API_KEY') || '')
  const save = (k) => { sessionStorage.setItem('SUNO_API_KEY', k); setKey(k) }
  const clear = () => { sessionStorage.removeItem('SUNO_API_KEY'); setKey('') }
  return { key, save, clear }
}

function humanTime(ts) {
  try { return new Date(ts).toLocaleString() } catch { return '' }
}

function App() {
  const { key: apiKey, save: saveKey, clear: clearKey } = useSessionKey()
  const [showKeyModal, setShowKeyModal] = useState(false)

  const backendBase = useMemo(() => {
    const envUrl = import.meta.env.VITE_BACKEND_URL
    if (envUrl) return envUrl
    try {
      const loc = window.location
      // Assume monorepo ports 3000(frontend) / 8000(backend)
      const backend = `${loc.protocol}//${loc.hostname}:8000`
      return backend
    } catch {
      return 'http://localhost:8000'
    }
  }, [])

  const defaultCallback = useMemo(() => `${backendBase}/callback`, [backendBase])

  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('V5')
  const [callbackUrl, setCallbackUrl] = useState(defaultCallback)

  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [trackId, setTrackId] = useState('')
  const [audioSrc, setAudioSrc] = useState('')
  const [lyrics, setLyrics] = useState(null)

  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.9)

  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('GEN_HISTORY') || '[]') } catch { return [] }
  })

  useEffect(() => {
    if (!apiKey) setShowKeyModal(true)
  }, [apiKey])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  useEffect(() => {
    localStorage.setItem('GEN_HISTORY', JSON.stringify(history))
  }, [history])

  const withKeyHeaders = (headers={}) => ({
    ...headers,
    'x-suno-api-key': apiKey,
  })

  async function pollStatus(id, { interval=3000, timeout=120000 } = {}) {
    const start = Date.now()
    let last = ''
    while (Date.now() - start < timeout) {
      const url = new URL(`${backendBase}/status`)
      url.searchParams.set('id', id)
      url.searchParams.set('api_key', apiKey)
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`Status error ${res.status}`)
      const data = await res.json()
      last = JSON.stringify(data)
      // Try to detect readiness: fields may vary; look for audio/mp3 url or state
      const ready = data.ready || data.status === 'ready' || data.state === 'completed' || data.audio_url || data.stream_url
      if (ready) return data
      setStatusMsg(`Generating... (${Math.ceil((Date.now()-start)/1000)}s)`) // feedback
      await new Promise(r => setTimeout(r, interval))
    }
    throw new Error(`Generation timed out. Last status: ${last}`)
  }

  async function fetchLyrics(id) {
    try {
      const url = new URL(`${backendBase}/lyrics`)
      url.searchParams.set('id', id)
      url.searchParams.set('api_key', apiKey)
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error('Failed to fetch lyrics')
      const data = await res.json()
      setLyrics(data)
    } catch (e) {
      setLyrics({ error: e.message })
    }
  }

  function buildStreamUrl(id){
    const url = new URL(`${backendBase}/stream`)
    url.searchParams.set('id', id)
    url.searchParams.set('api_key', apiKey)
    return url.toString()
  }

  async function handleGenerate() {
    if (!apiKey) { setShowKeyModal(true); return }
    if (!prompt.trim()) { alert('Please enter a prompt'); return }
    setBusy(true)
    setStatusMsg('Submitting to Suno...')
    setLyrics(null)
    try {
      const res = await fetch(`${backendBase}/generate?api_key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: withKeyHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prompt, model, callback_url: callbackUrl })
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      const id = data.id || data.track_id || data.job_id || data.result_id || data.task_id
      if (!id) throw new Error('No id returned from API')
      setTrackId(id)
      setStatusMsg('Queued. Waiting for completion...')
      const final = await pollStatus(id)
      const finalId = final.id || id
      setTrackId(finalId)
      const streamUrl = buildStreamUrl(finalId)
      setAudioSrc(streamUrl)
      await fetchLyrics(finalId)
      setStatusMsg('Ready!')
      setHistory(prev => [{
        id: finalId,
        at: Date.now(),
        prompt: prompt.slice(0,500),
        model,
        streamUrl,
      }, ...prev].slice(0,25))
    } catch (e) {
      setStatusMsg(`Error: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleStream() {
    if (!trackId) { alert('Generate first to get a track id.'); return }
    const url = buildStreamUrl(trackId)
    setAudioSrc(url)
  }

  async function handleDownload(idOverride) {
    const id = idOverride || trackId
    if (!id) { alert('Nothing to download yet.'); return }
    try {
      const url = new URL(`${backendBase}/download`)
      url.searchParams.set('id', id)
      url.searchParams.set('api_key', apiKey)
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error('Download failed')
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `suno-${id}.mp3`
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      alert(e.message)
    }
  }

  function onAudioPlay(){ setPlaying(true) }
  function onAudioPause(){ setPlaying(false) }

  // Simple timestamped lyric renderer (expects {lyrics: string | array})
  function LyricsView({ data }){
    if (!data) return null
    if (data.error) return <p className="text-red-300">{data.error}</p>
    const content = data.lyrics || data.data || data.text || ''
    if (Array.isArray(content)) {
      return (
        <div className="space-y-2">
          {content.map((line, i) => (
            <div key={i} className="flex gap-3 items-start">
              <span className="text-xs text-blue-300/70 mt-0.5 min-w-[48px]">{line.timestamp || ''}</span>
              <p className="text-blue-100 leading-relaxed">{line.words || line.line || ''}</p>
            </div>
          ))}
        </div>
      )
    }
    return <pre className="whitespace-pre-wrap text-blue-100/90 leading-relaxed">{content}</pre>
  }

  // API Key Modal
  function ApiKeyModal(){
    const [localKey, setLocalKey] = useState(apiKey)
    useEffect(()=>{ setLocalKey(apiKey) }, [apiKey])
    return (
      <div className={`fixed inset-0 z-50 ${showKeyModal ? '' : 'pointer-events-none'}`} aria-hidden={!showKeyModal}>
        <div className={`absolute inset-0 bg-black/60 transition-opacity ${showKeyModal ? 'opacity-100' : 'opacity-0'}`} />
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <div className={`w-full max-w-lg bg-slate-900 border border-blue-500/20 rounded-2xl p-6 shadow-2xl transition-transform ${showKeyModal ? 'scale-100' : 'scale-95'} `} role="dialog" aria-modal="true" aria-labelledby="apiKeyTitle">
            <div className="flex items-center gap-3 mb-4">
              <KeyRound className="text-blue-300" />
              <h2 id="apiKeyTitle" className="text-xl font-semibold text-white">Enter Suno API Key</h2>
            </div>
            <p className="text-blue-200/80 text-sm mb-4">Your key is only stored in this tab's session. It is sent to your own backend only to call Suno.</p>
            <input
              value={localKey}
              onChange={(e)=>setLocalKey(e.target.value)}
              placeholder="sk-..."
              className="w-full bg-slate-800 text-white rounded-lg px-4 py-3 outline-none border border-slate-700 focus:border-blue-500"
              aria-label="Suno API Key"
            />
            <div className="flex items-center justify-between mt-6 gap-3">
              <button onClick={()=>{ clearKey(); setLocalKey('') }} className="px-4 py-2 text-blue-200 hover:text-white/90">
                Clear
              </button>
              <div className="flex gap-3">
                <button onClick={()=>setShowKeyModal(false)} className="px-4 py-2 rounded-lg bg-slate-700 text-blue-100 hover:bg-slate-600">Cancel</button>
                <button onClick={()=>{ saveKey(localKey.trim()); setShowKeyModal(false) }} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold">Save Key</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white relative overflow-x-hidden">
      <ApiKeyModal />

      {/* Hero with Spline */}
      <header className="relative">
        <div className="absolute inset-0 pointer-events-none opacity-70">
          <Spline scene="https://prod.spline.design/4cHQr84zOGAHOehh/scene.splinecode" />
        </div>
        <div className="relative z-10 px-6 pt-16 pb-10 max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row items-center gap-8">
            <div className="flex-1">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-400/20 text-blue-200 text-xs mb-4">
                <Radio size={14} /> Realtime AI music generation
              </div>
              <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-4">Suno Music Studio</h1>
              <p className="text-blue-200/90 text-lg max-w-2xl">Generate, stream, and download AI music with full callback support. Bring your prompts to life in seconds.</p>
              <div className="mt-6 flex flex-wrap gap-3">
                <button onClick={()=>setShowKeyModal(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10">
                  <KeyRound size={16}/> API Key
                </button>
                <a href="/test" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500">
                  <Globe size={16}/> Backend Status
                </a>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Panel */}
      <main className="relative z-10 px-6 pb-24">
        <div className="max-w-6xl mx-auto grid lg:grid-cols-3 gap-8">
          {/* Left: Controls */}
          <section className="lg:col-span-2 bg-slate-900/60 border border-blue-500/20 rounded-2xl p-6 backdrop-blur-md shadow-xl">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm text-blue-200 mb-2">Prompt</label>
                <textarea
                  maxLength={500}
                  value={prompt}
                  onChange={(e)=>setPrompt(e.target.value)}
                  placeholder="Describe the music you want..."
                  className="w-full min-h-[120px] bg-slate-800 text-white rounded-lg px-4 py-3 outline-none border border-slate-700 focus:border-blue-500"
                  aria-describedby="promptHelp"
                />
                <div className="flex items-center justify-between mt-2 text-xs text-blue-300/80">
                  <span id="promptHelp">Max 500 characters</span>
                  <span>{prompt.length} / 500</span>
                </div>
              </div>

              <div>
                <label className="block text-sm text-blue-200 mb-2">Model</label>
                <select value={model} onChange={(e)=>setModel(e.target.value)} className="w-full bg-slate-800 text-white rounded-lg px-4 py-3 border border-slate-700 focus:border-blue-500">
                  {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-sm text-blue-200 mb-2 flex items-center gap-2"><LinkIcon size={14}/> Callback URL</label>
                <input
                  value={callbackUrl}
                  onChange={(e)=>setCallbackUrl(e.target.value)}
                  placeholder={defaultCallback}
                  className="w-full bg-slate-800 text-white rounded-lg px-4 py-3 outline-none border border-slate-700 focus:border-blue-500"
                />
                <p className="text-xs text-blue-300/80 mt-1">Customize or leave default. Suno will POST updates here asynchronously.</p>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <button onClick={handleGenerate} disabled={busy || !apiKey} className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50`}>
                {busy ? <Loader2 className="animate-spin" size={16}/> : <Wand2 size={16}/>} Generate
              </button>
              <button onClick={handleStream} disabled={!trackId} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 disabled:opacity-50">
                <Music2 size={16}/> Stream
              </button>
              <button onClick={()=>handleDownload()} disabled={!trackId} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 disabled:opacity-50">
                <Download size={16}/> Direct Download
              </button>
            </div>

            <div className="mt-4 text-sm text-blue-200/80 min-h-[24px]" role="status">{statusMsg}</div>

            {/* Live Preview */}
            <div className="mt-6 p-4 rounded-xl bg-slate-800/70 border border-slate-700">
              <h3 className="font-semibold mb-2 text-blue-100">Live Prompt Preview</h3>
              <p className="text-blue-200/90 leading-relaxed min-h-[48px]">{prompt || 'Your prompt preview will appear here...'}</p>
            </div>

            {/* Player */}
            <div className="mt-8 p-4 rounded-xl bg-slate-800/70 border border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 font-semibold text-blue-100"><Radio size={18}/> Player</div>
                <div className="flex items-center gap-2">
                  <Volume2 size={16} className="text-blue-200"/>
                  <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e)=>setVolume(parseFloat(e.target.value))} aria-label="Volume" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={()=>{ if(!audioRef.current) return; if(audioRef.current.paused){ audioRef.current.play(); } else { audioRef.current.pause(); } }}
                  className="w-12 h-12 rounded-full bg-blue-600 hover:bg-blue-500 flex items-center justify-center"
                  aria-label={playing ? 'Pause' : 'Play'}
                >
                  {playing ? <Pause/> : <Play/>}
                </button>
                <audio ref={audioRef} src={audioSrc} controls className="flex-1" onPlay={onAudioPlay} onPause={onAudioPause} />
              </div>
            </div>

            {/* Lyrics */}
            <div className="mt-8 p-4 rounded-xl bg-slate-800/70 border border-slate-700">
              <div className="flex items-center gap-2 font-semibold text-blue-100 mb-2"><Music2 size={18}/> Lyrics</div>
              {trackId ? (
                lyrics ? <LyricsView data={lyrics}/> : <p className="text-blue-300/80 text-sm">No lyrics yet.</p>
              ) : (
                <p className="text-blue-300/80 text-sm">Generate a track to see lyrics.</p>
              )}
            </div>
          </section>

          {/* Right: History */}
          <aside className="bg-slate-900/60 border border-blue-500/20 rounded-2xl p-6 backdrop-blur-md shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <div className="inline-flex items-center gap-2 font-semibold text-blue-100"><History size={18}/> History</div>
              <button onClick={()=>setHistory([])} className="text-xs text-blue-300/80 hover:text-blue-100">Clear</button>
            </div>
            {history.length === 0 ? (
              <p className="text-blue-300/80 text-sm">Your generations will appear here.</p>
            ) : (
              <ul className="space-y-4">
                {history.map(item => (
                  <li key={item.at + item.id} className="p-3 rounded-lg bg-slate-800/70 border border-slate-700">
                    <div className="text-xs text-blue-300/70 mb-1">{humanTime(item.at)} • {item.model}</div>
                    <div className="text-sm text-blue-100 mb-2 line-clamp-3">{item.prompt}</div>
                    <div className="flex items-center gap-2">
                      <button onClick={()=>{ setTrackId(item.id); setAudioSrc(item.streamUrl); fetchLyrics(item.id); }} className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs inline-flex items-center gap-1"><Play size={14}/> Play</button>
                      <button onClick={()=>handleDownload(item.id)} className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 border border-white/10 text-xs inline-flex items-center gap-1"><Download size={14}/> Download</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>

        {/* Footer */}
        <div className="max-w-6xl mx-auto mt-10 text-center text-sm text-blue-300/70">
          <p>Backend: {backendBase} • Your key is stored in sessionStorage only.</p>
        </div>
      </main>
    </div>
  )
}

export default App
