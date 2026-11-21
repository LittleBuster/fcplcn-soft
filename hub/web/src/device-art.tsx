/** @file SVG-иллюстрации помещений и оборудования FCPLCn без внешних ресурсов. */

import type { ComponentChildren } from 'preact';
import {
  DEFAULT_DEVICE_ILLUSTRATION,
  isDeviceIllustrationId,
  type DeviceIllustrationId,
} from '../../shared/device-art.js';
import { BoardArt } from './icons';
import './device-art.css';

/** Задаёт общую плоскость основания и тень для архитектурных иллюстраций. */
function Ground() {
  return (
    <>
      <ellipse class="da-shadow" cx="140" cy="141" rx="105" ry="8" />
      <path class="da-muted-line" d="M24 141h232" />
    </>
  );
}

/** Рисует окно с рамой и бликом, различимыми в уменьшенной карточке. */
function Window({
  x,
  y,
  width = 28,
  height = 34,
  warm = false,
}: {
  x: number;
  y: number;
  width?: number;
  height?: number;
  warm?: boolean;
}) {
  return (
    <g>
      <rect
        class={warm ? 'da-warm-glass' : 'da-glass'}
        x={x}
        y={y}
        width={width}
        height={height}
        rx="2"
      />
      <path
        class="da-window-frame"
        d={`M${x + width / 2} ${y}v${height}M${x} ${y + height / 2}h${width}`}
      />
      <path class="da-reflection" d={`m${x + 5} ${y + 10} 6-6m-6 14 12-12`} />
    </g>
  );
}

/** Рисует комнатное растение с заданным положением и масштабом. */
function Plant({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <path class="da-pot" d="M-12-1h24l-3 20H-9Z" />
      <path class="da-green-line" d="M0 0v-34m0 16-10-9m10 3 10-9" />
      <path
        class="da-leaf"
        d="M-1-21c-19 1-22-12-20-18 15 0 21 6 20 18Zm2-7c0-15 10-22 20-20 1 11-6 20-20 20Zm-1-5C-9-43-9-53-3-58 8-51 9-41 0-33Z"
      />
    </g>
  );
}

/** Рисует дерево для уличных сцен с заданным положением и масштабом. */
function Tree({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <path class="da-wood-line" d="M0 0v-44m0 22-13-13m13 9 13-13" />
      <path
        class="da-tree-back"
        d="M-22-35c-13-15-3-30 11-29-3-19 25-24 30-7 20-2 28 24 11 32 1 20-30 24-34 11-13 8-30 2-27-7Z"
      />
      <path
        class="da-leaf"
        d="M-23-48c-3-13 7-23 20-20 3-16 25-13 27 2 13 3 17 21 2 29-17-8-30 8-49-11Z"
      />
      <path class="da-green-line" d="M0-10v-41m0 15-12-9m12 3 12-10" />
    </g>
  );
}

/** Задаёт общую геометрию комнаты для интерьерных сцен. */
function Room() {
  return (
    <>
      <Ground />
      <rect class="da-room-wall" x="38" y="25" width="204" height="106" rx="4" />
      <path class="da-floor" d="M38 122h204l15 19H23Z" />
      <path class="da-muted-line" d="M38 122h204M57 141l9-19m45 19 3-19m45 19-3-19m45 19-9-19" />
    </>
  );
}

/** Рисует автомобиль, переиспользуемый в сценах гаража и парковки. */
function Car({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <rect class="da-tire" x="-44" y="4" width="13" height="25" rx="5" />
      <rect class="da-tire" x="31" y="4" width="13" height="25" rx="5" />
      <path class="da-metal" d="m-46 4 9-33a9 9 0 0 1 9-6h56a9 9 0 0 1 9 6L46 4v15h-92Z" />
      <path class="da-glass" d="m-32-27-6 24h76l-6-24Z" />
      <path class="da-reflection" d="m-18-22 10-4m-9 14 24-13" />
      <rect class="da-blue-face" x="-47" y="-1" width="94" height="25" rx="7" />
      <path class="da-amber-line" d="M-37 8h15m44 0h15" />
      <rect class="da-dark" x="-15" y="8" width="30" height="8" rx="3" />
      <path class="da-muted-line" d="M-43 18h12m62 0h12M-52-5h7m90 0h7" />
    </g>
  );
}

/** Рисует вентиль инженерного оборудования. */
function Valve({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle class="da-metal" r="7" />
      <path class="da-cyan-line" d="M-10-12h20M0-12v6" />
      <path class="da-muted-line" d="m-3-3 6 6m0-6-6 6" />
    </g>
  );
}

type Scene = Exclude<DeviceIllustrationId, 'board'>;

/** У каждой сцены своя композиция; повторяющиеся строительные детали вынесены в общие элементы. */
const scenes: Record<Scene, () => ComponentChildren> = {
  house: () => (
    <>
      <Ground />
      <Tree x={231} y={137} scale={0.72} />
      <path class="da-wall" d="M59 69h142v68H59Z" />
      <path class="da-wall-side" d="m201 69 19 9v59h-19Z" />
      <path class="da-roof" d="m43 72 87-53 87 53-9 10-78-46-78 46Z" />
      <path class="da-roof-edge" d="m130 19 87 53 16-4-89-52Z" />
      <path class="da-metal" d="M177 24h15v28l-15-9Z" />
      <Window x={76} y={83} />
      <Window x={153} y={83} warm />
      <rect class="da-door" x="113" y="88" width="32" height="49" rx="3" />
      <path class="da-warm-line" d="M137 111v9" />
      <path class="da-floor" d="M107 137h44l9 7H98Z" />
      <path class="da-green-line" d="M37 137h17m149 0h20" />
    </>
  ),

  apartment: () => (
    <>
      <Ground />
      <path class="da-wall-side" d="m181 17 26 13v108h-26Z" />
      <rect class="da-wall" x="66" y="17" width="115" height="121" rx="3" />
      <path class="da-roof" d="M60 12h127v9H60Z" />
      <path class="da-muted-line" d="M76 44h96M76 72h96M76 100h96" />
      {[29, 57, 85].flatMap((y, row) =>
        [79, 111, 143].map((x, column) => (
          <Window
            key={`${x}-${y}`}
            x={x}
            y={y}
            width={22}
            height={19}
            warm={(row + column) % 3 === 0}
          />
        )),
      )}
      <rect class="da-door" x="109" y="113" width="28" height="25" rx="2" />
      <path class="da-window-frame" d="M123 113v25m66-95h10m-10 29h10m-10 29h10" />
      <Plant x={46} y={126} scale={0.55} />
      <path class="da-floor" d="M101 138h44l8 6H94Z" />
    </>
  ),

  cottage: () => (
    <>
      <Ground />
      <Tree x={43} y={137} scale={0.8} />
      <path class="da-wall" d="M72 74h147v64H72Z" />
      <path class="da-wall-side" d="m219 74 17 10v54h-17Z" />
      <path class="da-roof" d="m59 78 66-53 71 53-10 8-61-43-55 43Z" />
      <path class="da-roof-edge" d="m125 25 71 53h45l-66-53Z" />
      <Window x={84} y={89} width={30} height={29} warm />
      <Window x={178} y={92} width={26} height={26} />
      <rect class="da-door" x="129" y="91" width="28" height="47" />
      <path class="da-wood-line" d="M120 84v54m48-54v54M116 82h57M117 126h54" />
      <path class="da-floor" d="M117 138h56l12 7h-79Z" />
      <path class="da-green-line" d="M29 141h34m135 0h48" />
      <path class="da-warm-line" d="M151 112v7" />
      <path class="da-smoke" d="M192 29c-9-8 8-12 0-21" />
      <path class="da-metal" d="M184 27h14v19h-14Z" />
    </>
  ),

  'living-room': () => (
    <>
      <Room />
      <Window x={58} y={39} width={60} height={46} />
      <path class="da-curtain" d="M51 33h11v59H48Zm62 0h12l3 59h-12Z" />
      <rect class="da-sofa-back" x="76" y="87" width="117" height="34" rx="10" />
      <rect class="da-soft" x="81" y="100" width="107" height="28" rx="7" />
      <rect class="da-sofa-arm" x="66" y="102" width="18" height="28" rx="6" />
      <rect class="da-sofa-arm" x="185" y="102" width="18" height="28" rx="6" />
      <path class="da-muted-line" d="M94 127v10m87-10v10m-47-36v24" />
      <path class="da-cushion" d="m89 91 22-4 4 19-22 4Zm63-2 22 3-3 19-21-3Z" />
      <path class="da-amber-fill" d="m206 46-13 25h31l-12-25Z" />
      <path class="da-metal-line" d="M209 72v62m-12 0h24" />
      <Plant x={48} y={121} scale={0.45} />
      <ellipse class="da-table" cx="137" cy="133" rx="28" ry="7" />
      <path class="da-wood-line" d="M116 135v7m42-7v7" />
    </>
  ),

  bedroom: () => (
    <>
      <Room />
      <Window x={178} y={39} width={42} height={40} />
      <path class="da-warm-fill" d="M204 45a10 10 0 1 0 9 14 10 10 0 0 1-9-14Z" />
      <rect class="da-wood" x="69" y="74" width="106" height="49" rx="6" />
      <path class="da-mattress" d="M74 88h96l13 39H62Z" />
      <path class="da-duvet" d="M69 105h106l8 22H62Z" />
      <path class="da-cyan-line" d="M67 116h110" />
      <rect class="da-pillow" x="82" y="90" width="32" height="14" rx="5" />
      <rect class="da-pillow" x="123" y="90" width="32" height="14" rx="5" />
      <path class="da-wood-line" d="M65 126v10m115-10v10" />
      <rect class="da-wall" x="193" y="102" width="28" height="27" rx="3" />
      <path class="da-muted-line" d="M195 114h24m-14-6h5m-14 21v7m22-7v7" />
      <path class="da-amber-fill" d="m201 83-7 13h25l-7-13Z" />
      <path class="da-metal-line" d="M206 96v6" />
      <path class="da-floor" d="M83 137h84l9 5H74Z" />
      <Plant x={51} y={118} scale={0.35} />
    </>
  ),

  kitchen: () => (
    <>
      <Room />
      <path
        class="da-tile"
        d="M47 59h185v40H47Zm0 20h185m-155-20v40m31-40v40m31-40v40m31-40v40m31-40v40"
      />
      <rect class="da-wall" x="49" y="34" width="51" height="25" rx="3" />
      <path class="da-muted-line" d="M74 35v23m-6-10v5m14-5v5" />
      <path class="da-metal" d="M133 33h22v20l16 11h-54l16-11Z" />
      <rect class="da-wall" x="50" y="97" width="181" height="37" rx="3" />
      <rect class="da-counter" x="46" y="92" width="188" height="7" rx="2" />
      <path class="da-muted-line" d="M92 100v33m76-33v33m31-33v33M57 109h26m93 0h16m15 0h15" />
      <rect class="da-dark" x="108" y="104" width="46" height="23" rx="3" />
      <path class="da-window-frame" d="M116 111h30" />
      <ellipse class="da-glass" cx="74" cy="92" rx="17" ry="4" />
      <path class="da-cyan-line" d="M72 90V78a7 7 0 0 1 14 0v4" />
      <path class="da-warm-line" d="M121 91h11m10 0h11" />
      <Window x={189} y={37} width={32} height={42} />
      <Plant x={183} y={89} scale={0.25} />
    </>
  ),

  bathroom: () => (
    <>
      <Room />
      <path class="da-tile" d="M39 58h202M39 91h202M72 26v96m34-96v96m34-96v96m34-96v96m34-96v96" />
      <path class="da-bath" d="M51 95h117l-8 28a10 10 0 0 1-10 7H71a12 12 0 0 1-11-8Z" />
      <ellipse class="da-water" cx="110" cy="95" rx="59" ry="8" />
      <path class="da-cyan-line" d="M64 95c15-5 29 4 44 0s27-2 45 0" />
      <path class="da-metal-line" d="M69 130v6m83-6v6M66 87V54a13 13 0 0 1 26 0v4" />
      <path class="da-metal" d="m83 60 18 1-4 5H84Z" />
      <path class="da-water-line" d="m85 73-2 8m10-8-1 9m8-9 2 8" />
      <rect class="da-glass" x="183" y="38" width="39" height="39" rx="13" />
      <path class="da-reflection" d="m191 58 13-13" />
      <path class="da-bath" d="M177 90h51l-7 13h-37Z" />
      <path class="da-metal-line" d="M201 90v-9h9m-10 22v31m-12 0h25" />
      <Plant x={239} y={121} scale={0.35} />
    </>
  ),

  hallway: () => (
    <>
      <Room />
      <rect class="da-wood" x="54" y="42" width="55" height="85" rx="3" />
      <rect class="da-door" x="61" y="49" width="41" height="78" rx="2" />
      <path class="da-warm-line" d="M94 88v9" />
      <rect class="da-glass" x="131" y="35" width="47" height="48" rx="18" />
      <path class="da-reflection" d="m141 57 19-15m-19 26 26-21" />
      <rect class="da-counter" x="123" y="96" width="64" height="7" rx="2" />
      <path class="da-wood-line" d="M129 103v29m52-29v29m-52-12h52" />
      <path class="da-amber-fill" d="M143 94h21l-4-5h-14Z" />
      <path class="da-metal-line" d="M214 49v77m-14-64h28m-24 0v-9m19 9v-9m-20 74h23" />
      <path class="da-coat" d="m204 70-8 7 6 6 3-3-1 24h19l-1-24 4 3 6-6-9-7Z" />
      <path class="da-floor" d="M53 131h67l12 9H41Z" />
      <path class="da-muted-line" d="M58 135h55" />
    </>
  ),

  'kids-room': () => (
    <>
      <Room />
      <path class="da-tent" d="m75 50-35 77h74Z" />
      <path class="da-tent-side" d="m75 50 53 77h-14Z" />
      <path class="da-dark" d="m75 83-19 44h38Z" />
      <path class="da-wood-line" d="m71 44 4 6 5-6" />
      <path class="da-warm-fill" d="m134 40 3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1Z" />
      <path class="da-amber-line" d="M158 38c-15 9-4 29 10 21-13-1-16-13-10-21Z" />
      <rect class="da-sofa-back" x="160" y="91" width="66" height="31" rx="8" />
      <rect class="da-soft" x="155" y="108" width="77" height="22" rx="6" />
      <path class="da-metal-line" d="M162 130v6m63-6v6" />
      <rect class="da-pillow" x="171" y="97" width="23" height="14" rx="5" />
      <rect class="da-toy-green" x="116" y="117" width="18" height="20" rx="2" />
      <rect class="da-toy-amber" x="132" y="124" width="20" height="13" rx="2" />
      <circle class="da-ball" cx="137" cy="112" r="9" />
      <path class="da-window-frame" d="m130 107 14 10m-14 0 14-10" />
      <path class="da-floor" d="M65 137h133l11 7H54Z" />
    </>
  ),

  office: () => (
    <>
      <Room />
      <Window x={53} y={37} width={52} height={44} />
      <rect class="da-wood" x="196" y="39" width="31" height="90" rx="2" />
      <path class="da-muted-line" d="M197 65h28m-28 29h28" />
      <path class="da-book-blue" d="M202 44h7v18h-7Zm0 30h8v17h-8Z" />
      <path class="da-book-green" d="M213 43h7v19h-7Zm1 28 7 3-4 17-7-3Z" />
      <rect class="da-counter" x="71" y="96" width="113" height="8" rx="2" />
      <path class="da-wood-line" d="M80 104v31m94-31v31" />
      <rect class="da-metal" x="113" y="48" width="53" height="36" rx="4" />
      <rect class="da-screen" x="118" y="53" width="43" height="25" rx="2" />
      <path class="da-cyan-line" d="m124 68 7-6 7 4 13-7" />
      <path class="da-metal-line" d="M139 84v10m-11 0h23" />
      <path class="da-window-frame" d="M114 100h43" />
      <path class="da-sofa-back" d="M95 113a11 11 0 0 1 22-3v20H95Z" />
      <path class="da-metal-line" d="M107 131v7m-11 2 11-2 12 2" />
      <Plant x={52} y={120} scale={0.45} />
      <path class="da-amber-line" d="M177 93V71l10-8m-14-3 15 7" />
    </>
  ),

  balcony: () => (
    <>
      <Ground />
      <rect class="da-room-wall" x="48" y="22" width="184" height="104" rx="3" />
      <Window x={100} y={31} width={84} height={92} />
      <path class="da-floor" d="M37 116h205l14 24H24Z" />
      <path
        class="da-metal-line"
        d="M29 104h221M31 104v36m218-36v36m-192-36v36m25-36v36m25-36v36m25-36v36m25-36v36m25-36v36m25-36v36m25-36v36"
      />
      <rect class="da-pot" x="29" y="96" width="43" height="16" rx="3" />
      <path
        class="da-leaf"
        d="M38 95c-11-10-6-24 1-26 8 9 6 18-1 26Zm13 0c-5-14 4-25 13-23 0 14-4 20-13 23Z"
      />
      <path class="da-wood-line" d="m192 93 8 25m20-25-7 25m-18-32 24 7m-25-7v-19h23v25" />
      <ellipse class="da-table" cx="146" cy="102" rx="18" ry="5" />
      <path class="da-metal-line" d="M146 107v16m-9 3 9-3 10 3" />
      <path class="da-bath" d="M139 91h11v8h-11Zm11 1h4v5h-4" />
    </>
  ),

  garage: () => (
    <>
      <Ground />
      <path class="da-wall" d="M49 53h183v85H49Z" />
      <path class="da-wall-side" d="m232 53 16 9v76h-16Z" />
      <path class="da-roof" d="m37 55 104-34 103 34-3 9H41Z" />
      <rect class="da-door" x="67" y="69" width="144" height="68" rx="3" />
      <path
        class="da-muted-line"
        d="M70 80h138M70 90h138M70 100h138M70 110h138M70 120h138M70 130h138"
      />
      <path class="da-window-frame" d="M61 65v72m156-72v72" />
      <rect class="da-warm-glass" x="126" y="43" width="30" height="9" rx="3" />
      <Car x={139} y={111} scale={0.91} />
      <path class="da-green-line" d="M47 137h11m168 0h17" />
    </>
  ),

  'boiler-room': () => (
    <>
      <Room />
      <rect class="da-bath" x="55" y="38" width="66" height="72" rx="8" />
      <rect class="da-screen" x="69" y="49" width="37" height="16" rx="3" />
      <path class="da-green-line" d="M77 57h19" />
      <circle class="da-metal" cx="88" cy="83" r="12" />
      <path class="da-amber-line" d="m88 83 5-6" />
      <path class="da-cyan-line" d="M70 111v19h106v-18" />
      <path class="da-hot-line" d="M105 111v10h91v-11" />
      <path class="da-metal" d="M162 45c0-10 49-10 49 0v68c0 10-49 10-49 0Z" />
      <ellipse class="da-blue-face" cx="186.5" cy="45" rx="24.5" ry="8" />
      <path class="da-muted-line" d="M163 65c10 9 37 9 47 0m-47 28c10 9 37 9 47 0" />
      <path class="da-metal-line" d="M178 37V27h-27m43 11V22h26" />
      <Valve x={139} y={129} />
      <Valve x={134} y={120} />
      <rect class="da-screen" x="177" y="78" width="19" height="12" rx="2" />
      <path class="da-warm-line" d="M81 37V24h14v13" />
    </>
  ),

  'electrical-panel': () => (
    <>
      <Ground />
      <path
        class="da-metal-line"
        d="M95 28V15m22 13V15m22 13V15m22 13V15m22 13V15M95 131v14m22-14v14m22-14v14m22-14v14m22-14v14"
      />
      <rect class="da-wall-side" x="63" y="24" width="159" height="111" rx="8" />
      <rect class="da-metal" x="58" y="20" width="156" height="112" rx="7" />
      <rect class="da-dark" x="69" y="31" width="134" height="89" rx="4" />
      <rect class="da-screen" x="82" y="40" width="44" height="26" rx="3" />
      <path class="da-green-line" d="M89 48h14m-14 9h27" />
      <circle class="da-amber-fill" cx="177" cy="50" r="5" />
      <path class="da-muted-line" d="M138 40h23m-23 9h16m-16 9h25" />
      <path class="da-metal-line" d="M77 78h118m-118 31h118" />
      {[84, 109, 134, 159, 184].map((x, index) => (
        <g key={x}>
          <rect class="da-bath" x={x - 5} y="79" width="18" height="29" rx="2" />
          <rect
            class={index === 4 ? 'da-amber-fill' : 'da-green-fill'}
            x={x}
            y="85"
            width="8"
            height="12"
            rx="1"
          />
          <path class="da-muted-line" d={`M${x - 1} 102h10`} />
        </g>
      ))}
      <path class="da-cyan-line" d="M78 126h45m25 0h44" />
      <path class="da-metal-line" d="M219 63h5v20h-5" />
    </>
  ),

  workshop: () => (
    <>
      <Room />
      <rect class="da-wood" x="59" y="35" width="154" height="54" rx="3" />
      {[47, 60, 73].flatMap((y) =>
        [70, 86, 102, 118, 134, 150, 166, 182, 198].map((x) => (
          <circle key={`${x}-${y}`} class="da-peg" cx={x} cy={y} r="1" />
        )),
      )}
      <path
        class="da-metal-line"
        d="m79 47 13 30m-20-31 13-5 5 9-13 5m34-9v25m-6-32h12v8h-12m30-3-7 12 12 19m16-33v35m-5-39h10v11h-10"
      />
      <path class="da-cyan-line" d="M187 47v25m-6-29h12v8h-12" />
      <rect class="da-counter" x="48" y="96" width="184" height="9" rx="2" />
      <path class="da-wood-line" d="M59 106v31m162-31v31M59 123h162" />
      <rect class="da-toolbox" x="119" y="80" width="45" height="16" rx="3" />
      <path class="da-metal-line" d="M131 80v-6h20v6m-11 0v16" />
      <path class="da-metal" d="M78 85h16v12H78Zm6-8h19v9H84Z" />
      <path class="da-metal-line" d="M81 96v12m-9 1h19m-20-16h9" />
      <rect class="da-wall" x="119" y="112" width="70" height="14" rx="2" />
      <path class="da-muted-line" d="M149 118h10" />
    </>
  ),

  'utility-room': () => (
    <>
      <Room />
      <rect class="da-bath" x="56" y="67" width="71" height="67" rx="6" />
      <path class="da-muted-line" d="M58 82h67" />
      <circle class="da-metal" cx="92" cy="108" r="21" />
      <circle class="da-glass" cx="92" cy="108" r="15" />
      <path class="da-water-line" d="M79 110c8-7 15 7 25-1" />
      <path class="da-green-line" d="M64 75h14" />
      <circle class="da-window-frame" cx="115" cy="75" r="3" />
      <path class="da-counter" d="M50 38h104v7H50Z" />
      <rect class="da-wood" x="60" y="24" width="25" height="14" rx="2" />
      <path class="da-towel" d="M95 26h25v11H95Zm4-9h25v9H99Z" />
      <path class="da-wood-line" d="m211 42-17 78" />
      <path class="da-amber-fill" d="m190 116 16 4-5 15h-20Z" />
      <path class="da-pot" d="M147 99h34l-4 33h-26Z" />
      <path class="da-metal-line" d="M150 100v-6a14 14 0 0 1 28 0v6" />
      <path class="da-towel" d="m145 100 4-11 15 3 3 10 10-7 8 6-7 9h-25Z" />
      <Plant x={215} y={123} scale={0.35} />
    </>
  ),

  sauna: () => (
    <>
      <Ground />
      <rect class="da-wood-wall" x="41" y="29" width="198" height="103" rx="4" />
      {[53, 71, 89, 107, 125, 143, 161, 179, 197, 215, 233].map((x) => (
        <path key={x} class="da-wood-grain" d={`M${x} 31v99`} />
      ))}
      <path class="da-wood" d="M54 89h99v12H54Zm0 27h117v12H54Z" />
      <path class="da-wood-line" d="M61 101v29m84-29v29m-84-20h84m-15 18v8m35-8v8" />
      <path class="da-metal" d="M184 93h37l-4 38h-29Z" />
      <ellipse class="da-dark" cx="202.5" cy="94" rx="20" ry="6" />
      <path class="da-stones" d="m188 94 3-7 8-1 6 4 8-3 7 7Z" />
      <path class="da-hot-line" d="M196 79c-9-9 9-13 0-23m14 23c-9-9 9-13 0-23" />
      <path class="da-pot" d="m66 73 2 14h22l3-14Z" />
      <path class="da-wood-line" d="m80 74 10-21" />
      <rect class="da-bath" x="158" y="42" width="10" height="32" rx="5" />
      <path class="da-hot-line" d="M163 63v6" />
      <path class="da-floor" d="M41 132h198l10 10H31Z" />
    </>
  ),

  greenhouse: () => (
    <>
      <Ground />
      <path class="da-greenhouse-side" d="m171 55 53-15 28 28v68h-81Z" />
      <path class="da-greenhouse-front" d="m55 64 58-40 58 40v72H55Z" />
      <path class="da-glass-roof" d="m113 24 53-15 58 31-53 15Z" />
      <path
        class="da-window-frame"
        d="M55 64h116m-58-40v112M84 45v91m58-91v91M55 94h116M171 55l24-7v88m29-96v96m-53-52 81-16m-81 40 81-16"
      />
      <rect class="da-greenhouse-door" x="96" y="84" width="33" height="52" rx="2" />
      <path class="da-warm-line" d="M122 109v7" />
      <Plant x={74} y={118} scale={0.35} />
      <Plant x={148} y={118} scale={0.35} />
      <Plant x={186} y={115} scale={0.5} />
      <Plant x={227} y={114} scale={0.48} />
      <circle class="da-tomato" cx="185" cy="96" r="3" />
      <circle class="da-tomato" cx="224" cy="97" r="3" />
    </>
  ),

  garden: () => (
    <>
      <Ground />
      <Tree x={215} y={126} scale={0.9} />
      <path class="da-garden-path" d="m44 138 43-32h43l39-39 19 4-43 47h-44l-24 20Z" />
      <path class="da-garden-bed" d="m40 102 49-26 44 11-46 29Z" />
      <path class="da-garden-bed" d="m111 132 45-28 49 12-40 25Z" />
      <path class="da-soil-line" d="m49 102 42-20m-29 28 44-24m15 45 39-21m-23 27 42-21" />
      {[
        [60, 91],
        [82, 79],
        [111, 124],
        [137, 111],
        [170, 122],
      ].map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <path class="da-green-line" d={`M${x} ${y + 9}v-16`} />
          <path
            class="da-leaf"
            d={`M${x} ${y}c-13 1-13-8-12-11 9 0 13 5 12 11Zm0-2c0-10 9-14 14-10 0 8-6 12-14 10Z`}
          />
        </g>
      ))}
      <path class="da-wood-line" d="M43 67V41m-5-3h10v7H38" />
      <path class="da-metal" d="M38 66h10v16l-5 6-5-6Z" />
      <path class="da-amber-fill" d="m182 45 3 4-1 5-5 1-4-4 2-5Z" />
      <path class="da-green-line" d="M180 55v26" />
    </>
  ),

  irrigation: () => (
    <>
      <Ground />
      <path class="da-grass-bed" d="M28 125h224v16H28Z" />
      <path class="da-green-line" d="m39 137 3-7 4 7m14 0 3-7 4 7m127 0 3-7 4 7m14 0 3-7 4 7" />
      <path class="da-cyan-line" d="M39 122h86m27 0h88" />
      <rect class="da-metal" x="127" y="111" width="25" height="24" rx="4" />
      <path class="da-metal-line" d="M139 112V91m-13 0h27" />
      <path
        class="da-water-line"
        d="M133 89C96 37 49 47 38 108m105-19c38-52 83-42 96 19M132 88C110 61 81 69 73 111m72-23c23-27 50-19 59 23M139 87V55"
      />
      <path
        class="da-droplet"
        d="m37 111-3 6a4 4 0 0 0 7 0Zm36 4-3 5a4 4 0 0 0 7 0Zm132 0-3 5a4 4 0 0 0 7 0Zm34-4-3 6a4 4 0 0 0 7 0Zm-100-68-3 6a4 4 0 0 0 7 0Z"
      />
      <Valve x={218} y={122} />
      <path class="da-muted-line" d="M104 141v-12m70 12v-12" />
    </>
  ),

  gates: () => (
    <>
      <Ground />
      <rect class="da-stone" x="39" y="58" width="29" height="81" rx="2" />
      <rect class="da-stone" x="211" y="58" width="29" height="81" rx="2" />
      <path class="da-metal" d="M34 52h39v9H34Zm172 0h39v9h-39Z" />
      <path
        class="da-stone-line"
        d="M40 80h27m-27 20h27m-27 20h27m-14-60v19m0 21v19m158-39h27m-27 20h27m-27 20h27m-14-60v19m0 21v19"
      />
      <path class="da-gate" d="M68 73c28-8 48-7 71 0v57H68Zm72 0c23-7 43-8 71 0v57h-71Z" />
      {[80, 94, 108, 122, 156, 170, 184, 198].map((x) => (
        <path key={x} class="da-metal-line" d={`M${x} 75v53`} />
      ))}
      <path class="da-window-frame" d="M70 89h67m5 0h67M70 117h67m5 0h67" />
      <path class="da-warm-line" d="M134 95v12m11-12v12" />
      <path class="da-metal-line" d="M52 50V29h18" />
      <path class="da-bath" d="m69 23 22 7-3 11-23-7Z" />
      <circle class="da-cyan-fill" cx="86" cy="34" r="3" />
      <path class="da-floor" d="M80 139h119l16 6H64Z" />
    </>
  ),

  'outdoor-lighting': () => (
    <>
      <Ground />
      <path class="da-distant-house" d="M165 91h63v43h-63Zm-8 0 40-28 40 28" />
      <Window x={180} y={102} width={20} height={21} warm />
      <path class="da-light-beam" d="m95 46-54 91h112Z" />
      <path class="da-metal-line" d="M88 137V40c0-11 16-15 23-7m-40 104h34" />
      <path class="da-metal" d="m103 31 22 6-5 13-22-6Z" />
      <path class="da-amber-fill" d="m102 44 16 4-5 4-11-3Z" />
      <path class="da-garden-path" d="m103 141 42-41 15 5-31 36Z" />
      <path class="da-amber-line" d="M206 136V116m-8-1h17" />
      <path class="da-warm-glass" d="M198 105h16v12h-16Z" />
      <Plant x={44} y={123} scale={0.4} />
      <Plant x={244} y={122} scale={0.36} />
      <path class="da-stars" d="M48 34v8m-4-4h8m190-11v6m-3-3h6" />
    </>
  ),

  well: () => (
    <>
      <Ground />
      <path class="da-wood-line" d="M79 56v73m120-73v73" />
      <path class="da-roof" d="m53 59 85-39 87 39-8 10-79-32-77 32Z" />
      <path class="da-roof-edge" d="m138 20 16-4 83 37-12 6Z" />
      <path class="da-metal-line" d="M83 73h110m-2-7v15m0-7h15v11" />
      <rect class="da-wood" x="116" y="65" width="44" height="15" rx="5" />
      <path class="da-wood-grain" d="M126 66v13m7-13v13m7-13v13m7-13v13" />
      <path class="da-warm-line" d="M139 80v31" />
      <path class="da-stone" d="M85 111c0-13 109-13 109 0v20c0 14-109 14-109 0Z" />
      <ellipse class="da-dark" cx="139.5" cy="110" rx="54.5" ry="12" />
      <path class="da-stone-line" d="M86 124c24 13 85 13 108 0m-78-9v22m44-22v22" />
      <path class="da-pot" d="m126 108 3 18h21l3-18Z" />
      <path class="da-metal-line" d="M129 108v-6a10 10 0 0 1 21 0v6" />
    </>
  ),

  'water-tank': () => (
    <>
      <Ground />
      <path class="da-metal-line" d="M92 122v16m78-16v16m-84 1h18m59 0h18" />
      <path class="da-tank" d="M77 40c0-22 108-22 108 0v79c0 22-108 22-108 0Z" />
      <ellipse class="da-blue-face" cx="131" cy="40" rx="54" ry="15" />
      <path class="da-water" d="M78 83c18 15 90 15 106 0v35c0 21-106 21-106 0Z" />
      <path class="da-water-line" d="M79 83c22 15 84 15 104 0m-94 24c12-6 27 5 41 0s24-3 41 0" />
      <rect class="da-glass" x="126" y="52" width="11" height="66" rx="4" />
      <path class="da-cyan-line" d="M131 84v28" />
      <path class="da-muted-line" d="M145 60h8m-8 13h8m-8 13h8m-8 13h8m-8 13h8" />
      <path class="da-metal-line" d="M184 111h30v24h25M95 27V16h22" />
      <Valve x={215} y={112} />
      <rect class="da-metal" x="212" y="50" width="28" height="32" rx="4" />
      <rect class="da-screen" x="218" y="57" width="16" height="9" rx="2" />
      <path class="da-green-line" d="M219 74h6" />
    </>
  ),

  septic: () => (
    <>
      <Ground />
      <path class="da-soil" d="M28 75h224v62H28Z" />
      <path class="da-grass-line" d="M27 75h226m-215-1 2-6 4 6m15 0 3-6 3 6m169 0 3-6 3 6" />
      <path class="da-tank" d="M61 85h71v43H61Zm82 0h72v43h-72Z" />
      <path class="da-water" d="M63 109h67v17H63Zm82 3h68v14h-68Z" />
      <path class="da-metal" d="M81 69h30v17H81Zm84 0h30v17h-30Z" />
      <path class="da-metal-line" d="M77 68h38m46 0h38" />
      <path class="da-cyan-line" d="M27 93h42v12m53-7h28v9m55-10h33V82h15" />
      <path class="da-water-line" d="M72 116c10-5 19 4 32 0m51 2c12-5 20 4 32 0" />
      <path class="da-muted-line" d="m40 118 5 2m-3-35h5m179 33 5 2m-190 12h5m172-44h5m-98 36h5" />
      <path class="da-cyan-line" d="m43 90 5 3-5 3m92-1 5 3-5 3m91-7 5 3-5 3" />
      <path class="da-hot-line" d="M96 64v-8m83 8v-8" />
    </>
  ),

  pool: () => (
    <>
      <Ground />
      <path class="da-stone" d="m44 78 132-10 75 57-154 15-70-43Z" />
      <path class="da-water" d="m52 82 120-8 61 47-135 13-60-38Z" />
      <path
        class="da-water-line"
        d="m77 93 17 9 16-2 18 8 15-2m8-15 17 8 17-1 14 10m-91 11 18 8 15-2 16 6"
      />
      <path class="da-bath" d="m69 87 18 14-14 2-17-13Z" />
      <path
        class="da-metal-line"
        d="M187 112V82a6 6 0 0 1 12 0v17m-27 1V72a6 6 0 0 1 12 0v17m-12-4 15 12m-15-2 15 12"
      />
      <path class="da-amber-fill" d="m81 21-40 24h80Z" />
      <path class="da-wood-line" d="M81 46v28" />
      <path class="da-wood" d="m36 58 38 12-6 9-39-12Z" />
      <path class="da-metal-line" d="m34 67-4 10m38 3-3 9m-28-30-5-15" />
      <Plant x={236} y={89} scale={0.4} />
    </>
  ),

  terrace: () => (
    <>
      <Ground />
      <path class="da-deck" d="M42 113h190l26 29H23Z" />
      <path
        class="da-wood-grain"
        d="M50 122h190M40 131h209m-174-18-11 29m48-29-3 29m41-29 5 29m34-29 12 29"
      />
      <path
        class="da-wood-line"
        d="M48 40v93m183-93v93M42 36h195M48 30h183M71 31v15m28-15v15m28-15v15m28-15v15m28-15v15m28-15v15"
      />
      <path class="da-muted-line" d="M51 52c58 25 118 25 176 0" />
      {[74, 105, 137, 169, 201].map((x, index) => (
        <g key={x}>
          <path class="da-metal-line" d={`M${x} ${index === 0 || index === 4 ? 61 : 68}v6`} />
          <circle class="da-warm-fill" cx={x} cy={index === 0 || index === 4 ? 71 : 78} r="4" />
        </g>
      ))}
      <ellipse class="da-table" cx="138" cy="111" rx="32" ry="10" />
      <path class="da-wood-line" d="M119 116v20m38-20v20" />
      <path class="da-sofa-back" d="M67 95h31v27H67Zm111 0h31v27h-31Z" />
      <path class="da-wood-line" d="M70 122v14m24-14v14m88-14v14m23-14v14" />
      <Plant x={227} y={116} scale={0.45} />
      <path class="da-bath" d="M132 102h11v9h-11Zm11 1h4v5h-4" />
    </>
  ),

  security: () => (
    <>
      <Ground />
      <path class="da-wall" d="M55 73h119v65H55Z" />
      <path class="da-roof" d="m41 75 73-51 74 51-8 9-66-44-65 44Z" />
      <Window x={68} y={88} width={29} height={30} />
      <rect class="da-door" x="114" y="91" width="33" height="47" rx="3" />
      <path class="da-green-line" d="M143 96h7v13m-8 9h3" />
      <path class="da-metal" d="m173 42 37 9-4 15-37-9Z" />
      <circle class="da-cyan-fill" cx="202" cy="58" r="4" />
      <path class="da-metal-line" d="m175 59-6 16h-11" />
      <path class="da-signal" d="M213 58c10 5 14 12 15 20m-11-24c17 5 25 18 25 30" />
      <path class="da-shield" d="m205 80 31 12v19c0 18-17 32-31 40-14-8-31-22-31-40V92Z" />
      <path class="da-green-line" d="m190 114 10 10 21-23" />
      <rect class="da-metal" x="102" y="57" width="23" height="11" rx="3" />
      <path class="da-green-line" d="M108 62h10" />
      <path class="da-muted-line" d="M198 141h-42" />
    </>
  ),

  ventilation: () => (
    <>
      <Room />
      <path class="da-duct" d="M46 38h53v22H46Zm130 0h58v22h-58Z" />
      <path class="da-metal" d="M94 29h87v67H94Z" />
      <circle class="da-glass" cx="137.5" cy="62.5" r="26" />
      <circle class="da-metal" cx="137.5" cy="62.5" r="7" />
      <path
        class="da-fan"
        d="M135 56c-12-21 14-24 17-12 3 9-4 13-10 16Zm9 10c23-4 17 21 5 21-10 0-12-9-12-17Zm-14 0c-10 21-28 3-21-6 6-8 15-4 21 1Z"
      />
      <path class="da-metal-line" d="M111 97v24h-42m95-24v24h43" />
      <path class="da-bath" d="M48 113h36v17H48Zm148 0h36v17h-36Z" />
      <path class="da-muted-line" d="M54 119h24m-24 5h24m124-5h24m-24 5h24" />
      <path
        class="da-water-line"
        d="M23 49h51m-10-5 10 5-10 5m138-5h51m-10-5 10 5-10 5M64 140v-5m150 5v-5"
      />
    </>
  ),
};

/**
 * Выбирает сцену по сохранённому идентификатору; неизвестное значение оставляет изображение PLC.
 */
export function DeviceArt({
  id,
  className = '',
}: {
  id?: DeviceIllustrationId | string;
  className?: string;
}) {
  const selected = isDeviceIllustrationId(id) ? id : DEFAULT_DEVICE_ILLUSTRATION;

  return (
    <span class={`device-art ${className}`} data-device-art={selected} aria-hidden="true">
      {selected === 'board' ? (
        <BoardArt />
      ) : (
        <svg
          class="device-art-scene"
          viewBox="0 0 280 160"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
          focusable="false"
          aria-hidden="true"
        >
          {scenes[selected]()}
        </svg>
      )}
    </span>
  );
}
