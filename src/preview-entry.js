import {startOriginalApp} from './original-app.js';
export const appReady=startOriginalApp();
await appReady;
const about=document.querySelector('.about-disclosure .about-card');if(about)about.textContent='ログイン不要・架空データ専用の独立 UI プレビューです。端末内の専用領域だけに保存します。本番・Firebase・GAS・実シートとは接続しません。実データは入力しないでください。';
if('serviceWorker' in navigator && location.pathname.startsWith('/routenote-ui-preview/'))navigator.serviceWorker.register('./sw.js',{scope:'/routenote-ui-preview/'});
