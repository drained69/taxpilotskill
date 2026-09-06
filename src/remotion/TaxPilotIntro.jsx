import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const C = {
  ink: '#173c35',
  inkDeep: '#0e2b25',
  inkPanel: '#0a1f1b',
  inkLine: '#1e3d34',
  inkSoft: '#31584e',
  lime: '#d5f35e',
  limeDeep: '#4d6b32',
  paper: '#f7f8f4',
  paperSoft: '#eaf1e4',
  paperTint: '#f3f6ee',
  white: '#ffffff',
  line: '#dfe8dc',
  muted: '#718078',
  blue: '#dce9f8',
  blueInk: '#3c648d',
  coral: '#f5ded8',
  coralInk: '#a95c54',
};

const font = 'Arial, Helvetica, sans-serif';
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const PROGRESS_STEPS = 7;

function appear(frame, start, distance = 18) {
  const progress = spring({ frame: frame - start, fps: 30, config: { damping: 16, stiffness: 130 } });
  return { opacity: progress, transform: `translateY(${interpolate(progress, [0, 1], [distance, 0])}px)` };
}

const SCENE_FRAMES = 150;

function sceneMotion(frame) {
  const opacity = interpolate(frame, [0, 10, SCENE_FRAMES - 10, SCENE_FRAMES], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scale = interpolate(frame, [0, SCENE_FRAMES], [1.025, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return { opacity, transform: `scale(${scale})` };
}

function Grid() {
  return <div style={{ position: 'absolute', inset: 0, opacity: .16, backgroundImage: 'linear-gradient(rgba(49,88,78,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(49,88,78,.18) 1px, transparent 1px)', backgroundSize: '72px 72px', pointerEvents: 'none' }} />;
}

function Header({ section, index, frame, light = false }) {
  const primary = light ? C.ink : C.white;
  const secondary = light ? C.muted : '#9ab0a5';
  const accent = light ? '#668c45' : C.lime;
  const badge = typeof index === 'number' ? String(index).padStart(2, '0') : 'TAXPILOT';
  return (
    <div style={{ ...appear(frame, 3), position: 'relative', zIndex: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ color: accent, fontSize: 31, lineHeight: 1 }}>✦</div>
        <div style={{ color: primary, fontFamily: font, fontWeight: 800, fontSize: 25, letterSpacing: -1 }}>TaxPilot</div>
      </div>
      <div style={{ color: secondary, fontFamily: mono, fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase' }}>{section}</div>
      <div style={{ color: accent, fontFamily: mono, fontSize: 13, letterSpacing: 1.1 }}>{badge}</div>
    </div>
  );
}

function Progress({ active, count = PROGRESS_STEPS, tone = 'dark' }) {
  const inactive = tone === 'dark' ? '#41675c' : '#d1dcc9';
  return (
    <div style={{ position: 'absolute', left: 76, right: 76, bottom: 45, display: 'flex', gap: 8 }}>
      {Array.from({ length: count }).map((_, item) => <div key={item} style={{ height: 4, flex: 1, borderRadius: 4, background: item <= active ? C.lime : inactive }} />)}
    </div>
  );
}

function Card({ children, tone = 'white', style = {} }) {
  return <div style={{ background: tone === 'white' ? C.white : tone, borderRadius: 18, padding: '28px 30px', boxShadow: '0 18px 50px rgba(18, 55, 45, .12)', ...style }}>{children}</div>;
}

function Label({ children, color = C.muted }) {
  return <div style={{ color, fontFamily: mono, fontSize: 11, fontWeight: 700, letterSpacing: 1.6, textTransform: 'uppercase' }}>{children}</div>;
}

function Chip({ children, tone = 'dark' }) {
  const dark = tone === 'dark';
  return <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: dark ? C.lime : C.limeDeep, background: dark ? C.inkLine : '#e3ecd4', borderRadius: 20, padding: '7px 14px', fontFamily: mono, fontSize: 11, fontWeight: 700, letterSpacing: 1.2 }}>{children}</div>;
}

function Hero({ frame }) {
  return <AbsoluteFill style={{ ...sceneMotion(frame), background: C.ink, padding: '54px 76px', color: C.white }}>
    <Grid />
    <Header section="crypto tax intelligence" index={1} frame={frame} />
    <div style={{ display: 'flex', flex: 1, alignItems: 'center', gap: 100 }}>
      <div style={{ width: 720 }}>
        <div style={{ ...appear(frame, 10) }}><Chip>✦ FOR BINANCE AGENT OS</Chip></div>
        <div style={{ ...appear(frame, 13), fontFamily: font, fontSize: 88, fontWeight: 800, lineHeight: .98, letterSpacing: -5, marginTop: 22 }}>Turn messy<br /><span style={{ color: C.lime }}>activity</span> into<br />tax clarity.</div>
        <div style={{ ...appear(frame, 22), color: '#b7c9bf', fontFamily: font, fontSize: 21, lineHeight: 1.45, marginTop: 26, maxWidth: 600 }}>Read-only, explainable crypto tax intelligence — powered by Binance Agent OS.</div>
      </div>
      <div style={{ position: 'relative', width: 620, height: 480, ...appear(frame, 18, 30) }}>
        <div style={{ position: 'absolute', right: 15, top: 0, width: 480, height: 390, background: '#f0f5e9', borderRadius: 20, transform: 'rotate(4deg)' }} />
        <Card style={{ position: 'absolute', right: 30, top: 48, width: 500, height: 355, transform: 'rotate(-3deg)', padding: 29 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}><Label>Net capital gain</Label><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, color: C.muted, fontFamily: mono, fontSize: 9, fontWeight: 700, letterSpacing: 1.1, lineHeight: 1.1, textAlign: 'right' }}><span style={{ color: C.inkSoft, fontSize: 16, letterSpacing: 0 }}>92%</span><span>DATA MATCHED</span></div></div>
          <div style={{ color: C.ink, fontFamily: font, fontSize: 52, fontWeight: 800, letterSpacing: -3, marginTop: 22 }}>+$25,645.80</div>
          <div style={{ display: 'flex', gap: 9, alignItems: 'end', height: 92, marginTop: 35 }}>{[32, 48, 40, 64, 55, 77, 68, 92].map((h, i) => <div key={i} style={{ flex: 1, height: `${h}%`, background: i === 7 ? C.ink : '#a8d66b', borderRadius: '4px 4px 0 0' }} />)}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: C.muted, fontFamily: mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, marginTop: 16, textTransform: 'uppercase' }}><span>18 disposals</span><span>FIFO</span></div>
        </Card>
        <div style={{ position: 'absolute', left: 0, bottom: 16, background: C.lime, color: C.ink, borderRadius: 12, padding: '18px 20px', fontFamily: font, fontSize: 17, fontWeight: 800, boxShadow: '0 15px 30px rgba(0,0,0,.2)' }}>Read-only by design <span style={{ fontWeight: 400 }}>↗</span></div>
      </div>
    </div>
    <Progress active={-1} />
  </AbsoluteFill>;
}

function AgentOsCard({ frame }) {
  const rows = [
    ['→', 'skill.initialize', 'MCP handshake with your agent', '#7fa08c'],
    ['←', 'tools/list', 'parse · normalize · value · match · export', '#7fa08c'],
    ['✓', 'READ-ONLY BY CONTRACT', 'no write verbs registered', C.lime],
    ['→', 'tools/call parse_activity', '412 rows from your CSV', C.lime],
    ['←', 'tax report + Form 8949', 'deterministic · replayable', C.lime],
  ];
  return <AbsoluteFill style={{ ...sceneMotion(frame), background: C.inkDeep, padding: '54px 76px', color: C.white }}>
    <Grid />
    <Header section="integration · mcp" index={2} frame={frame} />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 1, gap: 80 }}>
      <div style={{ width: 620, ...appear(frame, 7) }}>
        <Label color={C.lime}>Backbone</Label>
        <div style={{ fontFamily: font, fontSize: 66, fontWeight: 800, lineHeight: 1, letterSpacing: -3, marginTop: 20 }}>Built on<br /><span style={{ color: C.lime }}>Binance Agent OS.</span></div>
        <div style={{ color: '#b7c9bf', fontFamily: font, fontSize: 19, lineHeight: 1.5, marginTop: 26, maxWidth: 560 }}>TaxPilot ships as a read-only MCP skill. Every registered <span style={{ fontFamily: mono, color: C.lime }}>tools/call</span> is a read verb — the methodology never signs, trades, or approves.</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 30 }}><Chip>MCP · JSON-RPC</Chip><Chip>IN-AGENT</Chip><Chip>DETERMINISTIC</Chip></div>
      </div>
      <Card style={{ width: 760, padding: 32, background: C.inkPanel, ...appear(frame, 12, 28) }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: 20, borderBottom: `1px solid ${C.inkLine}` }}>
          <div><Label color="#8fa99d">MCP HANDSHAKE</Label><div style={{ color: C.white, fontFamily: font, fontSize: 24, fontWeight: 800, marginTop: 10 }}>Skill · agent session</div></div>
          <div style={{ color: C.lime, fontFamily: mono, fontSize: 12, letterSpacing: 1 }}>● LIVE</div>
        </div>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '15px 0', borderBottom: i < rows.length - 1 ? `1px solid ${C.inkLine}` : 'none' }}>
            <div style={{ width: 26, color: row[3], fontFamily: mono, fontSize: 16 }}>{row[0]}</div>
            <div style={{ flex: 1, fontFamily: mono, fontSize: 14, color: C.white }}>{row[1]}</div>
            <div style={{ color: '#7fa08c', fontFamily: mono, fontSize: 12 }}>{row[2]}</div>
          </div>
        ))}
      </Card>
    </div>
    <Progress active={0} />
  </AbsoluteFill>;
}

function LoadCard({ frame }) {
  return <AbsoluteFill style={{ ...sceneMotion(frame), background: C.paper, padding: '54px 76px', color: C.ink }}>
    <Grid />
    <Header section="01 / load" index={3} frame={frame} light />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 1, gap: 70 }}>
      <div style={{ width: 650 }}><div style={{ ...appear(frame, 7) }}><Label color={C.inkSoft}>Step 01</Label><div style={{ fontFamily: font, fontSize: 65, fontWeight: 800, lineHeight: 1, letterSpacing: -3, marginTop: 22 }}>Bring your<br />history to<br />your agent.</div><div style={{ color: C.muted, fontFamily: font, fontSize: 20, lineHeight: 1.5, marginTop: 28 }}>Export a CSV from Binance. Drop it into Claude, Cursor, or any MCP client. TaxPilot runs from there — no accounts, no keys.</div></div></div>
      <div style={{ width: 670, ...appear(frame, 12, 28) }}>
        <Card tone={C.ink} style={{ color: C.white, padding: 35 }}><div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 31 }}><div><Label color="#8fa99d">CSV → AGENT → SKILL</Label><div style={{ fontFamily: font, fontSize: 27, fontWeight: 800, marginTop: 12 }}>Load your workspace</div></div><div style={{ color: C.lime, fontSize: 22 }}>⌁</div></div>
          {[['1', 'Export CSV from Binance', 'Spot · converts · transfers · rewards'], ['2', 'Drop it into your agent', 'Claude, Cursor, or any MCP client'], ['3', 'Run the TaxPilot skill', 'Methodology runs in-context · no keys']].map((row, i) => <div key={row[0]} style={{ display: 'flex', alignItems: 'center', gap: 18, borderTop: `1px solid #31584e`, padding: '21px 0' }}><div style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 50, background: i === 0 ? C.lime : '#2b574b', color: i === 0 ? C.ink : C.white, fontFamily: mono, fontSize: 13 }}>{row[0]}</div><div style={{ flex: 1 }}><div style={{ fontFamily: font, fontSize: 17, fontWeight: 700 }}>{row[1]}</div><div style={{ color: '#91a99f', fontFamily: font, fontSize: 13, marginTop: 5 }}>{row[2]}</div></div><div style={{ color: i === 0 ? C.lime : '#668479', fontSize: 22 }}>›</div></div>)}
        </Card>
      </div>
    </div>
    <Progress active={1} />
  </AbsoluteFill>;
}

function ExplainCard({ frame }) {
  return <AbsoluteFill style={{ ...sceneMotion(frame), background: C.paperSoft, padding: '54px 76px', color: C.ink }}>
    <Grid />
    <Header section="02 / explain" index={4} frame={frame} light />
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ ...appear(frame, 7), display: 'flex', alignItems: 'end', justifyContent: 'space-between', marginBottom: 36 }}><div><Label color={C.inkSoft}>Step 02</Label><div style={{ fontFamily: font, fontSize: 60, fontWeight: 800, letterSpacing: -3, marginTop: 19 }}>Every event gets a reason.</div></div><div style={{ width: 370, color: C.muted, fontFamily: font, fontSize: 17, lineHeight: 1.45 }}>TaxPilot turns raw records into a traceable tax story — every USD price, every lot, every match kept intact.</div></div>
      <div style={{ display: 'flex', gap: 18, ...appear(frame, 13, 25) }}>
        {[['01', 'Normalize', 'Spot trades, transfers, deposits, withdrawals, rewards', C.white, C.inkSoft], ['02', 'Value', 'Historical USD price attached to each taxable event', C.white, C.inkSoft], ['03', 'Match lots', 'FIFO cost basis with source evidence kept intact', C.ink, C.lime]].map((item) => <Card key={item[0]} tone={item[3]} style={{ flex: 1, minHeight: 250, color: item[3] === C.ink ? C.white : C.ink }}><div style={{ color: item[4], fontFamily: mono, fontSize: 12, fontWeight: 700 }}>{item[0]}</div><div style={{ fontFamily: font, fontSize: 25, fontWeight: 800, marginTop: 45 }}>{item[1]}</div><div style={{ color: item[3] === C.ink ? '#a8c0b5' : C.muted, fontFamily: font, fontSize: 15, lineHeight: 1.45, marginTop: 13 }}>{item[2]}</div><div style={{ marginTop: 36, height: 5, background: item[3] === C.ink ? '#41675c' : C.line, borderRadius: 4 }}><div style={{ width: item[0] === '03' ? '100%' : '72%', height: 5, background: item[4], borderRadius: 4 }} /></div></Card>)}
      </div>
    </div>
    <Progress active={2} />
  </AbsoluteFill>;
}

function ReviewCard({ frame }) {
  return <AbsoluteFill style={{ ...sceneMotion(frame), background: C.ink, padding: '54px 76px', color: C.white }}>
    <Grid />
    <Header section="03 / review" index={5} frame={frame} />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 1, gap: 80 }}>
      <div style={{ width: 540, ...appear(frame, 7) }}><Label color="#9ab0a5">Step 03</Label><div style={{ fontFamily: font, fontSize: 62, fontWeight: 800, lineHeight: 1, letterSpacing: -3, marginTop: 22 }}>No black boxes.<br /><span style={{ color: C.lime }}>No guesses.</span></div><div style={{ color: '#b7c9bf', fontFamily: font, fontSize: 19, lineHeight: 1.5, marginTop: 28 }}>Unclear events pause for your decision. Every choice is persisted and replayable.</div></div>
      <Card style={{ width: 790, padding: 32, ...appear(frame, 12, 28) }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', paddingBottom: 23, borderBottom: `1px solid ${C.line}` }}><div><Label>Needs your attention</Label><div style={{ fontFamily: font, fontSize: 28, fontWeight: 800, marginTop: 10 }}>Tax Inbox <span style={{ color: C.coralInk }}>3</span></div></div><div style={{ color: C.blueInk, background: C.blue, borderRadius: 30, padding: '9px 14px', fontFamily: mono, fontSize: 11 }}>REVIEW QUEUE</div></div>
        {[['Missing cost basis', '0.35 ETH has no matching acquisition record.', 'HIGH PRIORITY · ETH · $1,124 EST.', C.coral, C.coralInk], ['Transfer or disposal?', 'BTC withdrawal needs your confirmation.', 'REVIEW · BTC', '#f4f3e2', '#9d8d45'], ['Reward classification', 'BNB reward needs a value at receipt.', 'REVIEW · BNB · 2 EVENTS', C.blue, C.blueInk]].map((item, i) => <div key={item[0]} style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '20px 0', borderBottom: i < 2 ? `1px solid ${C.line}` : 'none' }}><div style={{ width: 33, height: 33, borderRadius: 50, display: 'grid', placeItems: 'center', background: item[3], color: item[4], fontWeight: 800 }}>{i === 0 ? '!' : i === 1 ? '↔' : '◌'}</div><div style={{ flex: 1 }}><div style={{ fontFamily: font, fontSize: 16, fontWeight: 800 }}>{item[0]}</div><div style={{ color: C.muted, fontFamily: font, fontSize: 13, marginTop: 5 }}>{item[1]}</div><div style={{ color: item[4], fontFamily: mono, fontSize: 10, marginTop: 8, letterSpacing: .6 }}>{item[2]}</div></div><div style={{ border: `1px solid ${C.line}`, borderRadius: 5, padding: '9px 13px', color: C.inkSoft, fontFamily: font, fontSize: 12, fontWeight: 700 }}>Resolve</div></div>)}
      </Card>
    </div>
    <Progress active={3} />
  </AbsoluteFill>;
}

function ReportCard({ frame }) {
  return <AbsoluteFill style={{ ...sceneMotion(frame), background: C.paper, padding: '54px 76px', color: C.ink }}>
    <Grid />
    <Header section="04 / report" index={6} frame={frame} light />
    <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'space-between', gap: 90 }}>
      <div style={{ width: 580, ...appear(frame, 7) }}><Label color={C.inkSoft}>Step 04</Label><div style={{ fontFamily: font, fontSize: 64, fontWeight: 800, lineHeight: 1, letterSpacing: -3, marginTop: 21 }}>From review<br />to <span style={{ color: '#668c45' }}>ready to file.</span></div><div style={{ color: C.muted, fontFamily: font, fontSize: 19, lineHeight: 1.5, marginTop: 27 }}>Export your tax summary, Form 8949 rows, and an auditable event log.</div><div style={{ display: 'flex', gap: 10, marginTop: 32 }}><div style={{ background: C.ink, color: C.white, borderRadius: 6, padding: '14px 17px', fontFamily: font, fontSize: 13, fontWeight: 700 }}>Export report <span style={{ color: C.lime, marginLeft: 20 }}>↗</span></div><div style={{ border: `1px solid ${C.line}`, color: C.inkSoft, borderRadius: 6, padding: '14px 17px', fontFamily: font, fontSize: 13, fontWeight: 700 }}>Form 8949</div></div></div>
      <div style={{ width: 720, ...appear(frame, 12, 28) }}><Card style={{ padding: 34, transform: 'rotate(2deg)' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}><div><Label>Tax report</Label><div style={{ fontFamily: font, fontSize: 28, fontWeight: 800, marginTop: 12 }}>Tax summary</div></div><div style={{ color: '#62884b', fontFamily: mono, fontSize: 11, fontWeight: 700 }}>READY</div></div><div style={{ display: 'flex', gap: 35, marginTop: 33, padding: '23px 0', borderTop: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}` }}><div><Label>Capital gains</Label><div style={{ fontFamily: font, fontSize: 28, fontWeight: 800, marginTop: 9 }}>$34,860.20</div></div><div><Label>Losses</Label><div style={{ color: C.coralInk, fontFamily: font, fontSize: 28, fontWeight: 800, marginTop: 9 }}>-$9,214.40</div></div></div>{[['Form 8949 rows', '18 disposals'], ['Income summary', '4 events'], ['Supporting evidence', 'Attached']].map((row) => <div key={row[0]} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 0', borderBottom: `1px solid ${C.line}` }}><div style={{ fontFamily: font, fontSize: 15, fontWeight: 700 }}><span style={{ color: '#668c45', marginRight: 10 }}>✓</span>{row[0]}</div><div style={{ color: C.muted, fontFamily: mono, fontSize: 11 }}>{row[1]}</div></div>)}</Card></div>
    </div>
    <Progress active={4} />
  </AbsoluteFill>;
}

function SecurityCard({ frame }) {
  const rows = [
    ['◉', 'Read-only MCP surface', 'The skill only registers read verbs'],
    ['⌂', 'Runs in your agent', 'No network egress · your CSV never leaves the session'],
    ['≡', 'Deterministic snapshots', 'Same CSV + decisions → the exact same report'],
    ['✦', 'MIT · 55 tests', 'Methodology engine covered end-to-end'],
  ];
  return <AbsoluteFill style={{ ...sceneMotion(frame), background: C.paperSoft, padding: '54px 76px', color: C.ink }}>
    <Grid />
    <Header section="05 / trust" index={7} frame={frame} light />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 1, gap: 80 }}>
      <div style={{ width: 560, ...appear(frame, 7) }}>
        <Label color={C.inkSoft}>Step 05</Label>
        <div style={{ fontFamily: font, fontSize: 62, fontWeight: 800, lineHeight: 1, letterSpacing: -3, marginTop: 22 }}>Read-only.<br /><span style={{ color: '#668c45' }}>In-agent.</span><br />Auditable.</div>
        <div style={{ color: C.muted, fontFamily: font, fontSize: 19, lineHeight: 1.5, marginTop: 27, maxWidth: 500 }}>No write verbs. No network egress. Every event traceable back to a row in your CSV.</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 28 }}><Chip tone="light">READ-ONLY</Chip><Chip tone="light">IN-AGENT</Chip><Chip tone="light">✓ 55 TESTS</Chip></div>
      </div>
      <Card style={{ width: 780, padding: 32, ...appear(frame, 12, 28) }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: 20, borderBottom: `1px solid ${C.line}` }}>
          <div><Label>Security posture</Label><div style={{ fontFamily: font, fontSize: 25, fontWeight: 800, marginTop: 10 }}>Defence in depth</div></div>
          <div style={{ background: '#dcecc7', color: C.limeDeep, borderRadius: 20, padding: '8px 14px', fontFamily: mono, fontSize: 11, letterSpacing: 1 }}>READ-ONLY</div>
        </div>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '18px 0', borderBottom: i < rows.length - 1 ? `1px solid ${C.line}` : 'none' }}>
            <div style={{ width: 42, height: 42, borderRadius: 10, background: C.paperTint, color: C.ink, display: 'grid', placeItems: 'center', fontSize: 20 }}>{row[0]}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: font, fontSize: 16, fontWeight: 800 }}>{row[1]}</div>
              <div style={{ color: C.muted, fontFamily: font, fontSize: 13, marginTop: 4 }}>{row[2]}</div>
            </div>
            <div style={{ color: '#668c45', fontFamily: mono, fontSize: 18 }}>✓</div>
          </div>
        ))}
      </Card>
    </div>
    <Progress active={5} />
  </AbsoluteFill>;
}

function ChatCard({ frame }) {
  const summary = [
    ['Capital gains', '$34,860.20'],
    ['Realized losses', '-$9,214.40'],
    ['Form 8949 rows', '18'],
    ['Needs review', '3'],
  ];
  return <AbsoluteFill style={{ ...sceneMotion(frame), background: C.paper, padding: '54px 76px', color: C.ink }}>
    <Grid />
    <Header section="06 / use" index={8} frame={frame} light />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 1, gap: 80 }}>
      <div style={{ width: 580, ...appear(frame, 7) }}>
        <Label color={C.inkSoft}>Step 06</Label>
        <div style={{ fontFamily: font, fontSize: 62, fontWeight: 800, lineHeight: 1, letterSpacing: -3, marginTop: 20 }}>Ask your agent<br /><span style={{ color: '#668c45' }}>in plain English.</span></div>
        <div style={{ color: C.muted, fontFamily: font, fontSize: 19, lineHeight: 1.5, marginTop: 26, maxWidth: 500 }}>Attach your CSV. Type one line. TaxPilot handles parsing, matching, and reporting — every number traceable back to a row in your export.</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 28 }}><Chip tone="light">CLAUDE</Chip><Chip tone="light">CURSOR</Chip><Chip tone="light">ANY MCP CLIENT</Chip></div>
      </div>
      <Card style={{ width: 780, padding: 28, ...appear(frame, 12, 28) }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 16, borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: C.ink, color: C.lime, display: 'grid', placeItems: 'center', fontFamily: font, fontWeight: 800 }}>C</div>
            <div><Label>YOUR AGENT</Label><div style={{ fontFamily: font, fontSize: 18, fontWeight: 800, marginTop: 3 }}>Claude · TaxPilot skill</div></div>
          </div>
          <div style={{ color: '#62884b', fontFamily: mono, fontSize: 11, letterSpacing: 1 }}>● READY</div>
        </div>
        <div style={{ ...appear(frame, 16), marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ background: C.paperTint, borderRadius: 14, padding: '10px 14px', fontFamily: mono, fontSize: 13, color: C.inkSoft, border: `1px solid ${C.line}` }}>📎 binance_activity_2024.csv</div>
        </div>
        <div style={{ ...appear(frame, 22), marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ background: C.ink, color: C.white, borderRadius: 14, padding: '11px 16px', maxWidth: 480, fontFamily: font, fontSize: 15 }}>Run TaxPilot on this.</div>
        </div>
        <div style={{ ...appear(frame, 32), marginTop: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: C.lime, color: C.ink, display: 'grid', placeItems: 'center', fontWeight: 800, flexShrink: 0 }}>✦</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: font, fontSize: 14, color: C.ink, lineHeight: 1.5 }}>Parsed <b>412 events</b> · FIFO lots matched · <b>3 need your review.</b></div>
            <div style={{ background: C.paperSoft, borderRadius: 10, padding: '12px 16px', marginTop: 10 }}>
              {summary.map((row, i) => (
                <div key={row[0]} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontFamily: mono, fontSize: 12, color: C.inkSoft, borderTop: i > 0 ? `1px solid ${C.line}` : 'none' }}>
                  <span style={{ letterSpacing: .5 }}>{row[0]}</span><span style={{ color: C.ink, fontWeight: 800 }}>{row[1]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </div>
    <Progress active={6} />
  </AbsoluteFill>;
}

function Closer({ frame }) {
  const steps = [
    ['1', 'Export activity from Binance', 'Account → Export → CSV · spot, converts, transfers, rewards'],
    ['2', 'Install TaxPilot in your agent', 'npx skills add taxpilot · Claude, Cursor, or your own MCP client'],
    ['3', 'Drop the CSV into your chat', 'Attach the file, then ask: "run TaxPilot on this"'],
    ['4', 'Review · resolve · export', 'Answer the Tax Inbox, then export Form 8949 + summary'],
  ];
  return <AbsoluteFill style={{ ...sceneMotion(frame), background: C.ink, color: C.white, padding: '54px 76px' }}>
    <Grid />
    <Header section="get started" frame={frame} />
    <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'space-between', gap: 80 }}>
      <div style={{ width: 720, ...appear(frame, 7) }}>
        <div style={{ color: C.lime, fontSize: 34 }}>✦</div>
        <div style={{ fontFamily: font, fontSize: 66, fontWeight: 800, letterSpacing: -4, lineHeight: 1, marginTop: 14 }}>Know what happened.<br /><span style={{ color: C.lime }}>Know what to do next.</span></div>
        <div style={{ color: '#b7c9bf', fontFamily: font, fontSize: 19, lineHeight: 1.45, marginTop: 22, maxWidth: 560 }}>TaxPilot · explainable crypto tax intelligence for Binance Agent OS.</div>
        <div style={{ display: 'flex', gap: 12, marginTop: 28, ...appear(frame, 20) }}>
          <div style={{ background: C.lime, color: C.ink, borderRadius: 8, padding: '14px 22px', fontFamily: font, fontSize: 15, fontWeight: 800 }}>Install the skill <span style={{ marginLeft: 8 }}>↗</span></div>
          <div style={{ border: `1px solid #41675c`, color: C.white, borderRadius: 8, padding: '14px 22px', fontFamily: font, fontSize: 15, fontWeight: 800 }}>View on GitHub</div>
        </div>
        <div style={{ color: '#7fa08c', fontFamily: mono, fontSize: 12, letterSpacing: 1.4, marginTop: 24, textTransform: 'uppercase' }}>binance-skills-hub / taxpilot · mit license</div>
      </div>
      <Card style={{ width: 760, padding: 34, background: C.inkPanel, ...appear(frame, 14, 28) }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', paddingBottom: 22, borderBottom: `1px solid ${C.inkLine}` }}>
          <div>
            <Label color="#8fa99d">HOW TO USE IT</Label>
            <div style={{ color: C.white, fontFamily: font, fontSize: 27, fontWeight: 800, marginTop: 10 }}>Get started in 4 steps</div>
          </div>
          <div style={{ color: C.lime, fontFamily: mono, fontSize: 11, letterSpacing: 1.2 }}>~ 5 MIN</div>
        </div>
        {steps.map((row, i) => {
          const start = 18 + i * 4;
          return (
            <div key={row[0]} style={{ ...appear(frame, start, 14), display: 'flex', alignItems: 'flex-start', gap: 18, padding: '18px 0', borderBottom: i < steps.length - 1 ? `1px solid ${C.inkLine}` : 'none' }}>
              <div style={{ width: 36, height: 36, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 50, background: C.lime, color: C.ink, fontFamily: mono, fontSize: 14, fontWeight: 800 }}>{row[0]}</div>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.white, fontFamily: font, fontSize: 17, fontWeight: 800 }}>{row[1]}</div>
                <div style={{ color: '#91a99f', fontFamily: font, fontSize: 13, marginTop: 5 }}>{row[2]}</div>
              </div>
            </div>
          );
        })}
      </Card>
    </div>
    <Progress active={6} />
  </AbsoluteFill>;
}

export function TaxPilotIntro() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cardDuration = 5 * fps;
  const scene = Math.min(8, Math.floor(frame / cardDuration));
  const localFrame = frame - scene * cardDuration;
  const sceneProps = { frame: localFrame };
  return <AbsoluteFill style={{ fontFamily: font, overflow: 'hidden' }}>
    <Sequence from={0} durationInFrames={cardDuration}><Hero {...sceneProps} /></Sequence>
    <Sequence from={cardDuration} durationInFrames={cardDuration}><AgentOsCard {...sceneProps} /></Sequence>
    <Sequence from={cardDuration * 2} durationInFrames={cardDuration}><LoadCard {...sceneProps} /></Sequence>
    <Sequence from={cardDuration * 3} durationInFrames={cardDuration}><ExplainCard {...sceneProps} /></Sequence>
    <Sequence from={cardDuration * 4} durationInFrames={cardDuration}><ReviewCard {...sceneProps} /></Sequence>
    <Sequence from={cardDuration * 5} durationInFrames={cardDuration}><ReportCard {...sceneProps} /></Sequence>
    <Sequence from={cardDuration * 6} durationInFrames={cardDuration}><SecurityCard {...sceneProps} /></Sequence>
    <Sequence from={cardDuration * 7} durationInFrames={cardDuration}><ChatCard {...sceneProps} /></Sequence>
    <Sequence from={cardDuration * 8} durationInFrames={cardDuration}><Closer {...sceneProps} /></Sequence>
  </AbsoluteFill>;
}
