(function(){
  var t=0;
  setInterval(function(){
    fetch('/api/poll',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
      if(t&&d.mtime!==t){location.reload();}
      t=d.mtime;
    }).catch(function(){});
  },1000);
})();
