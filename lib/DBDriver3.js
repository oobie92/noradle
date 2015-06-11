/**
 * Created by cuccpkfs on 15-5-18.
 */


var frame = require('./util/frame.js')
  , debug = require('debug')('noradle:DBDriver')
  , Request = require('./Request3.js')
  , C = require('./constant.js')
  , net = require('net')
  ;


/**
 *
 * @param stream: a TCP socket or UNIX socket or any stream, used to exchange message with NORADLE dispatcher
 * @constructor
 * DBPool.freeList is only for slotIDs
 */
function DBDriver(stream, auth){
  var me = this;
  this.stream = stream;
  this.concurrency = 0;
  this.freeSlots = []; // it is local slots, not global
  this.waitQueue = [];
  this.quittingSet = [];
  this.requests = [];

  // accept/parse response from dispatcher
  stream.on('connect', function(){
    // parse stream from dispatcher to frames, slotID is for local
    frame.wrapFrameStream(stream, 197610263, 197610262, function(head, cSlotID, type, flag, len, body){
      debug('frame type = %d', type);
      if (cSlotID) {
        me.requests[cSlotID].emit('frame', head, cSlotID, type, flag, len, body);
        if (type === C.END_FRAME && len === 0) {
          // end of response, recycle slotID
          debug('return slotID(%j)', cSlotID);
          me.freeSlots.unshift(cSlotID);
          me.execQueuedCB();
        }
        return;
      }
      // control message
      switch (type) {
        case C.SET_CONCURRENCY:
          var concurrency = JSON.parse(body.toString('ascii'));
          debug('got set_concurrency to %d, %j', concurrency, body);
          if (concurrency > me.concurrency) {
            // add freeSlots, pick request from queue
            for (var i = me.concurrency; i < concurrency; i++) {
              me.freeSlots.push(i + 1);
              me.execQueuedCB();
            }
          } else {
            // mark high slot as quitting
            // when a busy quitting slot is free, do return it to freeSlots
          }
          me.concurrency = concurrency;
          break;
      }
    });
    // write first authenticate frame
    frame.writeFrame(stream, 0, C.AUTH_DATA, 0, new Buffer(JSON.stringify(auth)));
  });
}

/** got a request object to send request and receive response
 dbPool.findFree(env, dbSelector, function(err, request) {
   request.init(PROTOCOL, hprof);
   request.addHeaders( {name:value, ...}, prefix);
   request.addHeader(name, value);
   request.write(buffer);
   request.end(function(response){
     response.status;
     response.headers;
     response.on('frame', function(data){...});
     response.on('end', function(){...});
   });
 });
 */
DBDriver.prototype.findFree = function(env, dbSelector, cb, interrupter){
  var freeSlots = this.freeSlots
    , waitQueue = this.waitQueue
    ;
  if (freeSlots.length > 0) {
    var slotID = freeSlots.shift()
      , req = new Request(slotID, this.stream, env)
      ;

    debug('use slotID(%d) %j', slotID, freeSlots);
    this.requests[slotID] = req;
    cb(null, req);

    req.on('fin', function(){
      // slot.goFree();
    });

    req.on('error', function(){
      // slot.goFree();
    });
  } else {
    waitQueue.push(Array.prototype.slice.call(arguments, 0));
    debug('later push', waitQueue.length);
  }
  return interrupter;
};

DBDriver.prototype.execQueuedCB = function(){
  var waitQueue = this.waitQueue
    ;
  while (true) {
    var w = waitQueue.shift();
    if (!w) {
      return false;
    }
    if (w.aborted) {
      debug(w.env, 'abort in later queue');
      continue;
    }
    debug('executing a wait queue item', waitQueue.length);
    this.findFree.apply(this, w);
    return true;
  }
};

DBDriver.connect = function(addr, auth){
  var toDispatcherSocket = new net.Socket({allowHalfOpen : true})
    , dbDriver = new DBDriver(toDispatcherSocket, auth)
    ;
  toDispatcherSocket.connect.apply(toDispatcherSocket, addr);
  return dbDriver;
};

exports.DBDriver = DBDriver;