(function(){
var ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return ESC[c];});}
function fmt(s){return esc(s).replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/\n/g,'<br>');}
function lum(hex){var m=/^#?([0-9a-f]{6})$/i.exec(hex||'');if(!m)return 1;var n=parseInt(m[1],16);var ch=[n>>16&255,n>>8&255,n&255].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*ch[0]+0.7152*ch[1]+0.0722*ch[2];}
function h(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;}
function safeUrl(u){try{var x=new URL(u);return /^https?:$/.test(x.protocol)?x.href:null;}catch(e){return null;}}

function block(b,media,opt){
  opt=opt||{};
  switch(b.type){
    case 'heading': return h('h2','tp-h',fmt(b.text||''));
    case 'text': return h('div','tp-t',fmt(b.text||''));
    case 'image': {
      var f=h('figure','tp-img');
      if(b.asset){var i=document.createElement('img');i.src=media(b.asset);i.alt=b.caption||'';i.draggable=false;f.appendChild(i);}
      else f.appendChild(h('div','tp-ph','Image'));
      if(b.caption)f.appendChild(h('figcaption','',esc(b.caption)));
      return f;
    }
    case 'video': {
      var g=h('figure','tp-vid');
      if(b.asset){var v=document.createElement('video');v.src=media(b.asset);v.controls=true;v.playsInline=true;v.setAttribute('playsinline','');v.preload='metadata';g.appendChild(v);}
      else g.appendChild(h('div','tp-ph','Video'));
      if(b.caption)g.appendChild(h('figcaption','',esc(b.caption)));
      return g;
    }
    case 'quiz': {
      var w=h('div','tp-quiz'),opts=b.options||[],fb=h('div','tp-fb'),done=false;
      w.appendChild(h('div','tp-q',fmt(b.question||'')));
      var hasAns=typeof b.correct==='number'&&b.correct>=0&&b.correct<opts.length;
      opts.forEach(function(o,k){
        var btn=h('button','tp-opt',esc(o));btn.type='button';
        btn.addEventListener('click',function(){
          if(done)return;done=true;w.classList.add('answered');
          if(hasAns){
            w.querySelectorAll('.tp-opt')[b.correct].classList.add('right');
            if(k!==b.correct)btn.classList.add('wrong');
            fb.innerHTML=(k===b.correct?'<b>Correct!</b> ':'<b>Not quite.</b> ')+fmt(b.explain||'');
          }else{btn.classList.add('picked');fb.innerHTML=fmt(b.explain||'Thanks for answering.');}
          fb.classList.add('show');
          if(opt.onAnswer&&b.id)opt.onAnswer(b.id,k);
        });
        w.appendChild(btn);
      });
      w.appendChild(fb);
      return w;
    }
    case 'link': {
      var u=safeUrl(b.url),a=h('a','tp-link',esc(b.label||'Open link')+' ↗');
      if(u){a.href=u;a.target='_blank';a.rel='noopener noreferrer';}
      return a;
    }
  }
  return h('div');
}

function renderCard(card,opt){
  opt=opt||{};
  var media=opt.media||function(){return '';};
  var blocks=card.blocks||[];
  var fill=null;
  for(var k=0;k<blocks.length;k++){if(blocks[k].type==='image'&&blocks[k].fill&&blocks[k].asset){fill=blocks[k];break;}}
  var bg=card.bg||'#ffffff';
  var dark=fill?true:lum(bg)<0.4;
  var c=h('div','tp-card '+(dark?'tp-dark':'tp-light'));
  c.style.background=bg;
  c.style.setProperty('--tp-accent',opt.accent||'#ff5a36');
  if(fill){var bgEl=h('div','tp-bg');bgEl.style.backgroundImage='url("'+media(fill.asset)+'")';c.appendChild(bgEl);c.appendChild(h('div','tp-shade'));}
  var sc=h('div','tp-scroll'),inner=h('div','tp-inner');sc.appendChild(inner);c.appendChild(sc);
  blocks.forEach(function(b){if(b!==fill)inner.appendChild(block(b,media,opt));});
  if(!inner.children.length&&opt.editing)inner.appendChild(h('div','tp-empty','Empty card — add blocks from the panel'));
  return c;
}

function play(root,course,opt){
  opt=opt||{};
  var accent=course.accent||'#ff5a36';
  root.innerHTML='';root.classList.add('tp-root');root.style.setProperty('--tp-accent',accent);
  var cards=course.cards||[];
  var frame=h('div','tp-frame'),clip=h('div','tp-clip'),track=h('div','tp-track');
  clip.appendChild(track);frame.appendChild(clip);frame.appendChild(h('div','tp-island'));
  var els=cards.map(function(c){return renderCard(c,{media:opt.media,accent:accent,onAnswer:opt.onAnswer});});
  var end=h('div','tp-card tp-dark tp-end');end.style.background='#16151a';
  end.innerHTML='<div class="tp-scroll"><div class="tp-inner"><div class="tp-done">✓</div><h2 class="tp-h">You’re done</h2><div class="tp-t">'+esc(course.title||'')+'</div><button type="button" class="tp-again">Start again</button></div></div>';
  els.push(end);
  els.forEach(function(e){track.appendChild(e);});
  var prog=h('div','tp-progress');cards.forEach(function(){prog.appendChild(h('div','tp-seg','<i></i>'));});clip.appendChild(prog);
  if(opt.onExit){var x=h('button','tp-close','×');x.type='button';x.setAttribute('aria-label','Close');x.addEventListener('click',opt.onExit);clip.appendChild(x);}
  var hint=h('div','tp-hint','Swipe to continue');clip.appendChild(hint);
  var nav=h('div','tp-nav'),prev=h('button','tp-btn','‹'),count=h('div','tp-count'),next=h('button','tp-btn tp-next','›');
  prev.type=next.type='button';prev.setAttribute('aria-label','Previous');next.setAttribute('aria-label','Next');
  nav.appendChild(prev);nav.appendChild(count);nav.appendChild(next);clip.appendChild(nav);
  root.appendChild(frame);
  root.appendChild(h('div','tp-caption','Drag the card or use ← → keys'));
  var i=0,N=els.length;
  function go(n,anim){
    n=Math.max(0,Math.min(N-1,n));
    if(n>0)hint.classList.add('gone');
    i=n;
    track.style.transition=anim===false?'none':'transform .38s cubic-bezier(.2,.8,.2,1)';
    track.style.transform='translateX('+(-100*i)+'%)';
    els.forEach(function(e,k){
      if(k!==i)e.querySelectorAll('video').forEach(function(v){try{v.pause();}catch(_){}});
      e.setAttribute('aria-hidden',k!==i?'true':'false');
      e.inert=k!==i;
    });
    Array.prototype.forEach.call(prog.children,function(s,k){s.classList.toggle('on',k<=i);});
    frame.classList.toggle('tp-on-light',els[i].classList.contains('tp-light'));
    count.textContent=i<cards.length?(i+1)+' / '+cards.length:'';
    prev.disabled=i===0||i===N-1;next.disabled=i===N-1;
    if(opt.onChange)opt.onChange(i,cards.length,i===N-1);
  }
  prev.addEventListener('click',function(){go(i-1);});
  next.addEventListener('click',function(){go(i+1);});
  end.querySelector('.tp-again').addEventListener('click',function(){go(0);});

  /* ---- drag / swipe: touch events for fingers, pointer events for mouse & pen ---- */
  var sx=0,sy=0,st=0,dx=0,down=false,drag=false,moved=false;
  function dStart(x,y,target){
    if(target&&target.closest&&target.closest('video,input,textarea,select'))return;
    down=true;drag=false;moved=false;sx=x;sy=y;st=Date.now();dx=0;
  }
  function dMove(x,y){
    if(!down)return false;
    var mx=x-sx,my=y-sy;
    if(!drag){
      if(Math.abs(mx)>8&&Math.abs(mx)>Math.abs(my)*1.1){drag=true;moved=true;track.style.transition='none';}
      else{if(Math.abs(my)>14)down=false;return false;}
    }
    dx=mx;
    if((i===0&&dx>0)||(i===N-1&&dx<0))dx*=0.3;
    track.style.transform='translateX(calc('+(-100*i)+'% + '+dx+'px))';
    return true;
  }
  function dEnd(){
    if(!down)return;down=false;if(!drag)return;drag=false;
    var w=clip.clientWidth,v=dx/Math.max(1,Date.now()-st);
    if(dx<-w*0.18||(v<-0.35&&dx<-25))go(i+1);
    else if(dx>w*0.18||(v>0.35&&dx>25))go(i-1);
    else go(i);
  }
  track.addEventListener('touchstart',function(e){
    if(e.touches.length!==1){down=false;if(drag){drag=false;go(i);}return;}
    var t=e.touches[0];dStart(t.clientX,t.clientY,e.target);
  },{passive:true});
  track.addEventListener('touchmove',function(e){
    if(!down)return;var t=e.touches[0];
    if(dMove(t.clientX,t.clientY)&&e.cancelable)e.preventDefault();
  },{passive:false});
  track.addEventListener('touchend',dEnd);
  track.addEventListener('touchcancel',dEnd);
  var pid=null;
  track.addEventListener('pointerdown',function(e){
    if(e.pointerType==='touch')return;
    if(e.pointerType==='mouse'&&e.button!==0)return;
    pid=e.pointerId;dStart(e.clientX,e.clientY,e.target);
  });
  track.addEventListener('pointermove',function(e){
    if(e.pointerType==='touch'||e.pointerId!==pid)return;
    var was=drag;
    if(dMove(e.clientX,e.clientY)&&!was){try{track.setPointerCapture(pid);}catch(_){}}
  });
  function pUp(e){if(e.pointerType==='touch'||e.pointerId!==pid)return;pid=null;dEnd();}
  track.addEventListener('pointerup',pUp);track.addEventListener('pointercancel',pUp);
  track.addEventListener('click',function(e){if(moved){e.stopPropagation();e.preventDefault();moved=false;}},true);
  track.addEventListener('dragstart',function(e){e.preventDefault();});

  function key(e){
    var t=e.target;if(t&&t.closest&&t.closest('input,textarea'))return;
    if(e.key==='ArrowRight'||e.key==='PageDown'){go(i+1);}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){go(i-1);}
    else if(e.key==='Escape'&&opt.onExit){opt.onExit();}
  }
  window.addEventListener('keydown',key);
  go(Math.min(opt.start||0,N-1),false);
  return {go:go,destroy:function(){window.removeEventListener('keydown',key);root.innerHTML='';root.classList.remove('tp-root');}};
}
window.TapPlayer={renderCard:renderCard,play:play,esc:esc};
})();
