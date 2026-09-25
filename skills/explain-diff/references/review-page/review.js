(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('review-data').textContent);
  const L = data.labels, locale = data.lang;
  const $ = id => document.getElementById(id);
  const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const t = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key]);
  const sections = data.sections, order = data.order;
  const state = {section:'overview',file:null};
  window.explainDiffData = data; window.explainDiffState = state;
  // Source links exist only when the notes gave a remote_url; otherwise line numbers stay plain text.
  function sourceUrl(file, old=false, line=null) {
    const sha=old?data.before_sha:data.after_sha;
    if(!data.remote_url||!sha)return null;
    return `${data.remote_url}/blob/${sha}/${file.path.split('/').map(encodeURIComponent).join('/')}${line?'#L'+line:''}`;
  }
  function nav() {
    $('review-nav').innerHTML=order.map(key=>`<button type="button" class="pr-link ${key===state.section?'active':''}" data-section="${key}" aria-pressed="${key===state.section}"><span class="letter">${sections[key].number||'↗'}</span><span><strong>${e(sections[key].nav)}</strong></span></button>`).join('');
    $('section-select').innerHTML=order.map(key=>`<option value="${key}" ${key===state.section?'selected':''}>${sections[key].number?sections[key].number+' · ':''}${e(sections[key].nav)}</option>`).join('');
  }
  function renderChanges() {
    const all=data.changes;
    const terms=$('change-search').value.trim().toLocaleLowerCase(locale).split(/\s+/).filter(Boolean);
    const list=all.filter(change=>terms.every(term=>change.search.toLocaleLowerCase(locale).includes(term)));
    $('change-count').textContent=t(L.change_count,{n:list.length,total:all.length});
    let group=null,followup=false;
    $('changes').innerHTML=list.map(change=>{
      let head='';
      if(change.followup&&!followup){followup=true;group=null;head=`<h3 class="file-group followup-title">${e(L.followup_heading)}</h3>`;}
      if(group!==change.group){group=change.group;head+=`<h3 class="file-group"><code>${e(group)}</code></h3>`;}
      const tone={keep:'green',cut:'red',trim:'amber',ask:'amber'}[change.verdict];
      return head+`<article class="paper change" id="change-${e(change.id)}"><div class="change-title"><span class="id">${e(change.id)}</span><h3>${e(change.title)}</h3><span class="pill ${tone}">${e(L.verdicts[change.verdict])}</span>${change.followup?`<span class="pill">${e(L.followup_tag)}</span>`:''}</div><div class="change-columns"><div><span class="label">${e(L.before)}</span><p>${change.before_html}</p></div><div class="after"><span class="label">${e(change.followup?L.after_followup:L.after)}</span><p>${change.after_html}</p></div></div><p class="why"><b>${e(L.meaning)} · </b>${change.why_html}</p>${typeof change.followup==='string'||change.fixed_by.length?`<div class="example"><b>${e(L.followup_tag)}</b>${typeof change.followup==='string'?`<button class="jump" data-change="${e(change.followup)}">${e(t(L.fixes,{id:change.followup}))}</button>`:''}${change.fixed_by.map(id=>`<button class="jump" data-change="${e(id)}">${e(t(L.fixed_by,{id}))}</button>`).join(' ')}</div>`:''}<div class="file-links">${change.files.map(path=>`<button type="button" data-open-file="${e(path)}">${e(path)} ↗</button>`).join('')}</div>${change.evidence_html.length?`<div class="evidence-links">${change.evidence_html.join('')}</div><p class="caption evidence-basis">${e(t(L.evidence_basis,{ref:change.ref}))}</p>`:''}</article>`;
    }).join('');
    $('no-changes').hidden=list.length>0;
    $('no-changes').innerHTML=`<p>${e(L.no_matches)}</p><button class="jump" data-reset-changes>${e(L.reset_search)}</button>`;
  }
  function filteredFiles() {
    const terms=$('file-search').value.trim().toLocaleLowerCase(locale).split(/\s+/).filter(Boolean);
    return data.delta.filter(file=>($('file-kind').value==='all'||file.kind===$('file-kind').value)&&terms.every(term=>(file.path+' '+file.explanation+' '+file.patch).toLocaleLowerCase(locale).includes(term)));
  }
  function renderCode() {
    const all=data.delta,files=filteredFiles();
    $('diff-basis').textContent=t(L.diff_basis,{before:data.before,after:data.after,n:all.length,added:all.reduce((n,f)=>n+f.added,0),removed:all.reduce((n,f)=>n+f.removed,0)});
    $('version-note').textContent=data.remote_url?L.version_note+' '+L.version_note_links:L.version_note;
    if(!$('download-patch').href)$('download-patch').href=URL.createObjectURL(new Blob([all.map(f=>f.patch).join('')],{type:'text/x-diff'}));
    if(state.file&&!files.some(file=>file.path===state.file))state.file=null;
    $('file-count').textContent=t(L.file_count,{n:files.length,total:all.length});
    $('file-list').innerHTML=files.map(file=>`<button type="button" class="file-button ${file.path===state.file?'active':''}" data-file="${e(file.path)}" aria-pressed="${file.path===state.file}">${e(file.path)}<small>${e(L.kinds[file.kind])} · <span class="added">+${file.added}</span> <span class="removed">−${file.removed}</span></small></button>`).join('');
    $('file-empty').hidden=files.length>0;
    $('diff-panel').hidden=!state.file;
    $('diff-placeholder').hidden=!!state.file;
    if(!state.file)return;
    const file=files.find(f=>f.path===state.file);
    $('file-name').textContent=file.path;$('file-category').textContent=L.kinds[file.kind];
    $('file-stat').textContent=t(L.file_stat,{added:file.added,removed:file.removed});
    $('file-explanation').textContent=file.explanation;
    const isNew=/^new file mode/m.test(file.patch),isDeleted=/^deleted file mode/m.test(file.patch);
    const link=(url,label)=>url?`<a href="${e(url)}" target="_blank" rel="noopener">${e(label)} ↗</a>`:`<span>${e(label)}</span>`;
    $('source-links').innerHTML=(isNew?`<span>${e(L.new_file)}</span>`:link(sourceUrl(file,true),t(L.old_source,{ref:data.before})))+(isDeleted?`<span>${e(L.deleted_file)}</span>`:link(sourceUrl(file),t(L.new_source,{ref:data.after})));
    $('code-body').innerHTML=renderPatch(file);$('code-body').scrollTop=0;
  }
  // Unified hunk renderer: git's own patch text with before/after line numbers added.
  function renderPatch(file) {
    let oldLine=0,newLine=0,inHunk=false;
    const lines=file.patch.replace(/\n$/,'').split('\n').map(line=>{
      const match=line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if(match) { oldLine=+match[1];newLine=+match[2];inHunk=true; }
      let type='meta',o='',n='',sign='',text=line;
      if(!match&&inHunk) {
        if(line.startsWith('+')) { type='add';n=newLine++;sign='+';text=line.slice(1); }
        else if(line.startsWith('-')) { type='del';o=oldLine++;sign='−';text=line.slice(1); }
        else if(line.startsWith(' ')) { type='context';o=oldLine++;n=newLine++;text=line.slice(1); }
      }
      const num=(number,old)=>{
        if(!number)return '';
        const url=sourceUrl(file,old,number);
        return url?`<a href="${e(url)}" target="_blank" rel="noopener" aria-label="${e(t(old?L.line_old:L.line_new,{n:number}))}">${number}</a>`:String(number);
      };
      return `<div class="diff-line ${type}"><span class="old">${num(o,true)}</span><span class="new">${num(n,false)}</span><span class="sign">${sign}</span><span class="code">${e(text)||' '}</span></div>`;
    });
    return '<div class="diff-lines">'+lines.join('')+'</div>';
  }
  function render() {
    nav();
    $('intro').hidden=state.section!=='overview';$('overview-panel').hidden=state.section!=='overview';
    for(const key of order.filter(k=>k!=='overview'))$(key+'-section').hidden=state.section!==key;
    if(state.section==='changes')renderChanges();
    if(state.section==='code')renderCode();
  }
  function resetFiles(){$('file-search').value='';$('file-kind').value='all';}
  function hash(replace=false,change=null){
    const params=new URLSearchParams();if(state.section==='code'&&state.file)params.set('file',state.file);if(change)params.set('change',change);
    history[replace?'replaceState':'pushState'](null,'','#'+state.section+(params.size?'?'+params:''));
  }
  function choose(section){
    if(!sections[section])return;state.section=section;render();hash();window.scrollTo({top:0,behavior:'instant'});
  }
  function openFile(path){
    if(!data.delta.some(f=>f.path===path))return;
    state.section='code';state.file=path;resetFiles();render();hash();$('diff-panel').scrollIntoView({behavior:'instant'});$('code-body').focus({preventScroll:true});
  }
  function openChange(id){
    state.section='changes';$('change-search').value='';render();hash(false,id);
    const card=$('change-'+id);card?.scrollIntoView({behavior:'instant'});if(card){card.tabIndex=-1;card.focus({preventScroll:true});}
  }
  function readHash(){
    const [key,query='']=location.hash.slice(1).split('?'),params=new URLSearchParams(query);
    state.section=sections[key]?key:'overview';state.file=params.get('file');resetFiles();$('change-search').value='';render();
    requestAnimationFrame(()=>{
      if(params.has('change'))$('change-'+params.get('change'))?.scrollIntoView({behavior:'instant'});
      else if(state.section==='code'&&state.file)$('diff-panel').scrollIntoView({behavior:'instant'});
      else window.scrollTo({top:0,behavior:'instant'});
    });
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.section)choose(button.dataset.section);
    if(button.dataset.openFile)openFile(button.dataset.openFile);
    if(button.dataset.file){state.file=button.dataset.file;renderCode();hash(true);if(innerWidth<650){$('diff-panel').scrollIntoView({behavior:'instant'});$('code-body').focus({preventScroll:true});}}
    if(button.dataset.change)openChange(button.dataset.change);
    if(button.hasAttribute('data-reset-changes')){$('change-search').value='';renderChanges();}
  });
  $('section-select').addEventListener('change',event=>choose(event.target.value));
  $('change-search').addEventListener('input',renderChanges);
  $('file-search').addEventListener('input',renderCode);$('file-kind').addEventListener('change',renderCode);
  $('reset-files').addEventListener('click',()=>{resetFiles();renderCode();});
  $('file-search').addEventListener('keydown',event=>{if(event.key==='Escape'){resetFiles();renderCode();}});
  $('wrap-lines').addEventListener('change',()=>{$('code-body').classList.toggle('wrap',$('wrap-lines').checked);});
  window.addEventListener('hashchange',readHash);readHash();
})();
