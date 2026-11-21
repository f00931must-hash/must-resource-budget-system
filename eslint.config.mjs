export default [{
  files: ['app-v120.js', 'budget-*.js', 'budget-*.mjs'],
  languageOptions: {ecmaVersion:2022, sourceType:'module', globals:Object.fromEntries([
    'window','document','location','navigator','sessionStorage','localStorage','alert','confirm','prompt','fetch','Headers','FormData','File','Blob','URL','console','setTimeout','clearTimeout','setInterval','clearInterval','MutationObserver','Event','CustomEvent','requestAnimationFrame','cancelAnimationFrame','AbortController','getComputedStyle','HTMLElement','HTMLInputElement','atob','TextEncoder','TextDecoder','crypto','FileReader','ResizeObserver','Node','DOMParser','Option','ExcelJS','JSZip','CSS','history'
  ].map(name=>[name,'readonly']))},
  rules:{'no-undef':'error'}
}];
