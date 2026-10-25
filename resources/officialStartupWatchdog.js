class __companionStartupWatchdog{
  constructor(onTimeout){
    this.onTimeout=onTimeout;
    this.timeout=void 0;
    this.disposed=!1;
    this.receivedWebviewMessage=!1;
    this.timeoutMs=3e4;
    this.visible=!0;
    this.started=!1;
    this.remainingMs=this.timeoutMs;
    this.visibleElapsedMs=0;
    this.startedAt=void 0;
    this.visibleSince=void 0;
  }
  start(){
    if(this.disposed||this.started)return;
    this.started=!0;
    this.startedAt=Date.now();
    if(this.visible)this.arm();
  }
  arm(){
    if(this.disposed||!this.visible||this.timeout!=null)return;
    var self=this;
    this.visibleSince=Date.now();
    this.timeout=setTimeout(function(){
      self.timeout=void 0;
      if(self.disposed||!self.visible)return;
      var now=Date.now();
      self.visibleElapsedMs+=now-self.visibleSince;
      self.visibleSince=void 0;
      self.remainingMs=0;
      self.disposed=!0;
      self.onTimeout({
        elapsedMs:now-self.startedAt,
        receivedWebviewMessage:self.receivedWebviewMessage,
        timeoutMs:self.timeoutMs,
        visibleElapsedMs:self.visibleElapsedMs
      });
    },Math.max(0,this.remainingMs));
  }
  setVisible(value){
    var visible=value!==!1;
    if(visible===this.visible)return;
    this.visible=visible;
    if(visible){
      if(this.started&&!this.disposed)this.arm();
      return;
    }
    if(this.timeout!=null){clearTimeout(this.timeout);this.timeout=void 0}
    if(this.visibleSince!=null){
      var now=Date.now();
      var spent=now-this.visibleSince;
      this.visibleElapsedMs+=spent;
      this.remainingMs=Math.max(0,this.remainingMs-spent);
      this.visibleSince=void 0;
    }
  }
  markMessageReceived(){this.receivedWebviewMessage=!0}
  handleStartupPhase(phase){if(phase==="renderer_ready")this.dispose()}
  dispose(){
    this.disposed=!0;
    if(this.timeout!=null){clearTimeout(this.timeout);this.timeout=void 0}
    this.visibleSince=void 0;
  }
}
function __companionBindStartupVisibility(watchdog,panel){
  if(!watchdog||typeof watchdog.setVisible!=="function"||!panel)return;
  var subscription=void 0;
  var closed=!1;
  function cleanup(){
    if(closed)return;
    closed=!0;
    var listener=subscription;
    subscription=void 0;
    try{listener&&typeof listener.dispose==="function"&&listener.dispose()}catch(e){}
  }
  function apply(){
    if(closed)return;
    var visible;
    try{visible=panel.visible!==!1}catch(e){
      cleanup();
      try{watchdog.dispose()}catch(_e){}
      return;
    }
    try{watchdog.setVisible(visible)}catch(e){}
  }
  apply();
  if(closed)return;
  try{
    subscription=panel.onDidChangeViewState?panel.onDidChangeViewState(apply):void 0;
  }catch(e){
    cleanup();
    try{watchdog.dispose()}catch(_e){}
    return;
  }
  return {dispose:function(){cleanup()}};
}
