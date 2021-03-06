"use strict";

/**
 * @module opcua.client
 */

var util = require("util");
var EventEmitter = require("events").EventEmitter;

var _ = require("underscore");
var assert = require("node-opcua-assert");

var resolveNodeId = require("node-opcua-nodeid").resolveNodeId;

var DataValue = require("node-opcua-data-value").DataValue;

var NodeId = require("node-opcua-nodeid").NodeId;
var coerceNodeId = require("node-opcua-nodeid").coerceNodeId;

var Variant = require("node-opcua-variant").Variant;
var DataType = require("node-opcua-variant").DataType;

var StatusCodes = require("node-opcua-status-code").StatusCodes;
var makeResultMask = require("node-opcua-data-model").makeResultMask;
var BrowseDirection = require("node-opcua-data-model").BrowseDirection;
var makeNodeClassMask = require("node-opcua-data-model").makeNodeClassMask;

var subscription_service = require("node-opcua-service-subscription");
var read_service = require("node-opcua-service-read");
var historizing_service = require("node-opcua-service-history");
var browse_service = require("node-opcua-service-browse");
var write_service = require("node-opcua-service-write");
var call_service = require("node-opcua-service-call");

var utils = require("node-opcua-utils");
var debugLog = require("node-opcua-debug").make_debugLog(__filename);
var doDebug = require("node-opcua-debug").checkDebugFlag(__filename);
var helpAPIChange = process.env.DEBUG && process.env.DEBUG.match(/API/);

var getFunctionParameterNames = require("node-opcua-utils").getFunctionParameterNames;

/**
 * @class ClientSession
 * @param client {OPCUAClient}
 * @constructor
 */
var ClientSession = function (client) {
    this._closeEventHasBeenEmmitted = false;
    this._client = client;
    this._publishEngine = null;
    this._closed = false;
};
util.inherits(ClientSession, EventEmitter);

/**
 * @method getPublishEngine
 * @return {ClientSidePublishEngine}
 */
ClientSession.prototype.getPublishEngine = function () {

    if (!this._publishEngine) {

        var ClientSidePublishEngine = require("../src/client_publish_engine").ClientSidePublishEngine;
        this._publishEngine = new ClientSidePublishEngine(this);
    }

    return this._publishEngine;
};

function coerceBrowseDescription(data) {
    if (typeof data === "string" || data instanceof NodeId) {
        return coerceBrowseDescription({
            nodeId: data,
            includeSubtypes: true,
            browseDirection: BrowseDirection.Both,
            nodeClassMask: 0,
            resultMask: 63
        });
    } else {
        data.nodeId = resolveNodeId(data.nodeId);
        data.referenceTypeId = data.referenceTypeId ? resolveNodeId(data.referenceTypeId) : null;
        return new browse_service.BrowseDescription(data);
    }
}

/**
 * @method browse
 * @async
 * @param nodesToBrowse           {String|BrowseDescription}
 * @param callback               {Function}
 * @param callback.err           {Error|null}
 * @param callback.browseResult  {BrowseResult}
 *
 * @example:
 *
 *    ``` javascript
 *    session.browse("RootFolder",function(err,browseResult) {
 *      if(err) return callback(err);
 *      console.log(browseResult.toString());
 *      callback();
 *    } );
 *    ```
 *
 *
 * @example
 *
 * ``` javascript
 *    var browseDescription = {
 *       nodeId: "ObjectsFolder",
 *       referenceTypeId: "Organizes",
 *       browseDirection: BrowseDirection.Inverse,
 *       includeSubtypes: true,
 *       nodeClassMask: 0,
 *       resultMask: 63
 *    }
 *    session.browse(browseDescription,function(err, browseResult) {
 *       if(err) return callback(err);
 *       console.log(browseResult.toString());
 *       callback();
 *    });
 *    ```
 *
 * @method browse
 * @async
 * @param nodesToBrowse           {Array<String|BrowseDescription>}
 * @param callback                {Function}
 * @param callback.err            {Error|null}
 * @param callback.browseResults  {Array<BrowseResult>}  an array containing the BrowseResult of each BrowseDescription.
 *
 * @example
 *
 * ``` javascript
 * session.browse([ "RootFolder", "ObjectsFolder"],function(err, browseResults) {
 *       assert(browseResults.length === 2);
 * });
 * ```
 *
 * @example
 *   ``` javascript
 *    var browseDescriptions = [
 *      {
 *          nodeId: "ObjectsFolder",
 *          referenceTypeId: "Organizes",
 *          browseDirection: BrowseDirection.Inverse,
 *          includeSubtypes: true,
 *          nodeClassMask: 0,
 *          resultMask: 63
 *      },
 *      // {...}
 *    ]
 *    session.browse(browseDescriptions,function(err, browseResults) {
 *
 *    });
 *    ```
 *
 * @method browse
 * @async
 * @param nodesToBrowse                 {Array<String|BrowseDescription>}
 * @return {Promise<Array<BrowseResult>>}
 *
 * @method browse
 * @async
 * @param nodesToBrowse                 {String|BrowseDescription}
 * @return {Promise<BrowseResult>}
 *
 */
ClientSession.prototype.browse = function (nodesToBrowse, callback) {

    var self = this;

    self.requestedMaxReferencesPerNode = self.requestedMaxReferencesPerNode || 10000;
    assert(_.isFinite(self.requestedMaxReferencesPerNode));
    assert(_.isFunction(callback));

    var isArray = _.isArray(nodesToBrowse);
    if (!isArray) {
        nodesToBrowse = [nodesToBrowse];
     }

    var nodesToBrowse = nodesToBrowse.map(coerceBrowseDescription);

    var request = new browse_service.BrowseRequest({
        nodesToBrowse: nodesToBrowse,
        requestedMaxReferencesPerNode: self.requestedMaxReferencesPerNode
    });

    self.performMessageTransaction(request, function (err, response) {

        var i, r;

        if (err) {
            return callback(err, response);
        }

        assert(response instanceof browse_service.BrowseResponse);

        if (self.requestedMaxReferencesPerNode > 0) {

            for (i = 0; i < response.results.length; i++) {
                r = response.results[i];

                /* istanbul ignore next */
                if (r.references && r.references.length > self.requestedMaxReferencesPerNode) {
                    console.log("warning".yellow + " BrowseResponse : server didn't take into account our requestedMaxReferencesPerNode ");
                    console.log("        self.requestedMaxReferencesPerNode= " + self.requestedMaxReferencesPerNode);
                    console.log("        got " + r.references.length + "for " + nodesToBrowse[i].nodeId.toString());
                    console.log("        continuationPoint ", r.continuationPoint);
                }
            }
        }
        for (i = 0; i < response.results.length; i++) {
            r = response.results[i];
            r.references = r.references || [];
        }
        // detect unsupported case :
        // todo implement proper support for r.continuationPoint
        for (i = 0; i < response.results.length; i++) {
            r = response.results[i];

            if (r.continuationPoint !== null) {
                console.log(" warning:".yellow, " BrowseResponse : server didn't send all references and has provided a continuationPoint. Unfortunately we do not support this yet");
                console.log("           self.requestedMaxReferencesPerNode = ", self.requestedMaxReferencesPerNode);
                console.log("           continuationPoint ", r.continuationPoint);
            }
        }

        return callback(null, isArray ? response.results: response.results[0]);


    });
};


/**
 * @method readVariableValue
 * @async
 * @param node               {NodeId}    - the nodeId of the  value to read
 * @param callback           {Function}  - the callback function
 * @param callback.err       {Error|null}- the error if write has failed or null if OK
 * @param callback.dataValue {DataValue} - the dataValue
 *
 * @example:
 *
 *     session.readVariableValue("ns=2;s=Furnace_1.Temperature",function(err,dataValue) {
 *        if(err) { return callback(err); }
 *        if (dataValue.statusCode === opcua.StatusCodes.Good) {
 *        }
 *        console.log(dataValue.toString());
 *        callback();
 *     });
 *
 * @method readVariableValue
 * @async
 * @param nodes              {Array<NodeId>}    - an array of node to Read
 * @param callback           {Function}         - the callback function
 * @param callback.err       {Error|null}       - the error if write has failed or null if OK
 * @param callback.results   {Array<DataValue>} - an array of dataValue each read
 *
 *
 *
 * @example
 *
 *   session.readVariableValue(["ns=0;i=2257","ns=0;i=2258"],function(err,dataValues) {
 *      if (!err) {
 *         console.log(dataValues[0].toString());
 *         console.log(dataValues[1].toString());
 *      }
 *   });
 *
 * @method readVariableValue
 * @async
 * @param node               {NodeId|string}    - the nodeId of the UAVariable to read
 * @return {Promise<DataValue>}
 * @example
 *     const dataValue = await session.readVariableValue("ns=1;s=Temperature");
 *
 * @method readVariableValue
 * @async
 * @param nodes              {Array<NodeId>}    - an array of node to Read
 * @return {Promise<Array<DataValue>>}
 *
 * @example
 *     const dataValues = await session.readVariableValue(["ns=1;s=Temperature","ns=1;s=Pressure"]);
 */
ClientSession.prototype.readVariableValue = function (nodes, callback) {

    var self = this;

    assert(_.isFunction(callback));


    var isArray = _.isArray(nodes);
    if (!isArray) {
        nodes = [nodes];
    }

    function coerceReadValueId(node) {

        if (typeof node === "string" || node instanceof NodeId) {
            return new read_service.ReadValueId({
                nodeId: resolveNodeId(node),
                attributeId: read_service.AttributeIds.Value,
                indexRange: null,
                dataEncoding: {namespaceIndex: 0, name: null}
            });

        } else {
            assert(node instanceof Object);
            return new read_service.ReadValueId(node);
        }
    }

    var nodesToRead = nodes.map(coerceReadValueId);

    var request = new read_service.ReadRequest({
        nodesToRead: nodesToRead,
        timestampsToReturn: read_service.TimestampsToReturn.Neither
    });

    assert(nodes.length === request.nodesToRead.length);

    self.performMessageTransaction(request, function (err, response) {

        /* istanbul ignore next */
        if (err) {
            return callback(err, response);
        }
        if (response.responseHeader.serviceResult !== StatusCodes.Good) {
            return callback(new Error(response.responseHeader.serviceResult.toString()));
        }
        assert(response instanceof read_service.ReadResponse);
        assert(nodes.length === response.results.length);

        response.results = response.results || [];

        var results         = isArray ? response.results : response.results[0];
        callback(null, results);

    });

};


/**
 * @method readHistoryValue
 * @async
 * @example:
 *
 *     session.readHistoryValue("ns=5;s=Simulation Examples.Functions.Sine1","2015-06-10T09:00:00.000Z","2015-06-10T09:01:00.000Z",function(err,dataValues) {} );
 *
 * @param nodes  {ReadValueId[]} - the read value id
 * @param start - the starttime in UTC format
 * @param end - the endtime in UTC format
 * @param {Function} callback -   the callback function
 * @param callback.err {object|null} the error if write has failed or null if OK
 * @param callback.results {DataValue[]} - an array of dataValue each read
 */
ClientSession.prototype.readHistoryValue = function (nodes, start, end, callback) {

    var self = this;
    assert(_.isFunction(callback));
    var isArray = _.isArray(nodes);
    if (!isArray) {
        nodes = [nodes];
    }

    var nodesToRead = [];
    var historyReadDetails = [];
    nodes.forEach(function (node) {
        nodesToRead.push({
            nodeId: resolveNodeId(node),
            indexRange: null,
            dataEncoding: {namespaceIndex: 0, name: null},
            continuationPoint: null
        });
    });

    var ReadRawModifiedDetails = new historizing_service.ReadRawModifiedDetails({
        isReadModified: false,
        startTime: start,
        endTime: end,
        numValuesPerNode: 0,
        returnBounds: false
    });

    var request = new historizing_service.HistoryReadRequest({
        nodesToRead: nodesToRead,
        historyReadDetails: ReadRawModifiedDetails,
        timestampsToReturn: read_service.TimestampsToReturn.Neither,
        releaseContinuationPoints: false
    });

    assert(nodes.length === request.nodesToRead.length);
    self.performMessageTransaction(request, function (err, response) {

        if (err) {
            return callback(err, response);
        }

        if (response.responseHeader.serviceResult !== StatusCodes.Good) {
            return callback(new Error(response.responseHeader.serviceResult.toString()));
        }

        assert(response instanceof historizing_service.HistoryReadResponse);
        assert(nodes.length === response.results.length);

        callback(null, isArray ? response.results : response.results[0]);
    });
};


/**
 *
 * @method write
 * @param nodesToWrite {Array.<WriteValue>}  - the array of value to write. One or more elements.
 * @param {Function} callback -   the callback function
 * @param callback.err {object|null} the error if write has failed or null if OK
 * @param callback.statusCodes {StatusCode[]} - an array of status code of each write
 * @async
 *
 * @example
 *
 *     const nodesToWrite = [
 *     {
 *          nodeId: "ns=1;s=SetPoint1",
 *          attributeIds: opcua.AttributeIds.Value,
 *          value: {
 *             statusCode: Good,
 *             value: {
 *               dataType: opcua.DataType.Double,
 *               value: 100.0
 *             }
 *          }
 *     },
 *     {
 *          nodeId: "ns=1;s=SetPoint2",
 *          attributeIds: opcua.AttributeIds.Value,
 *          value: {
 *             statusCode: Good,
 *             value: {
 *               dataType: opcua.DataType.Double,
 *               value: 45.0
 *             }
 *          }
 *     }
 *     ];
 *     session.write(nodesToWrite,function (err,statusCodes) {
 *       if(err) { return callback(err);}
 *       //
 *     });
 *
 * @method write
 * @param nodeToWrite {WriteValue}  - the value to write
 * @param {Function} callback -   the callback function
 * @param callback.err {object|null} the error if write has failed or null if OK
 * @param callback.statusCode {StatusCodes} - the status code of the write
 * @async
 *
 * @example
 *
 *     const nodeToWrite = {
 *          nodeId: "ns=1;s=SetPoint",
 *          attributeIds: opcua.AttributeIds.Value,
 *          value: {
 *             statusCode: Good,
 *             value: {
 *               dataType: opcua.DataType.Double,
 *               value: 100.0
 *             }
 *          }
 *     };
 *     session.write(nodeToWrite,function (err,statusCode) {
 *       if(err) { return callback(err);}
 *       //
 *     });
 *
 *
 * @method write
 * @param nodeToWrite {WriteValue}  - the value to write
 * @return {Promise<StatusCode>}
 * @async
 *
 * @example
 *   session.write(nodeToWrite).then(function(statusCode) { });
 *
 * @example
 *   const statusCode = await session.write(nodeToWrite);
 *
 * @method write
 * @param nodesToWrite {Array<WriteValue>}  - the value to write
 * @return {Promise<Array<StatusCode>>}
 * @async
 *
 * @example
 *   session.write(nodesToWrite).then(function(statusCodes) { });
 *
 * @example
 *   const statusCodes = await session.write(nodesToWrite);
 */
ClientSession.prototype.write = function (nodesToWrite, callback) {

    var self = this;

    var isArray = _.isArray(nodesToWrite);
    if (!isArray) {
        nodesToWrite = [nodesToWrite];
    }

    assert(_.isFunction(callback));
    assert(_.isArray(nodesToWrite), "nodesToWrite must be an array");

    var request = new write_service.WriteRequest({nodesToWrite: nodesToWrite});

    self.performMessageTransaction(request, function (err, response) {

        /* istanbul ignore next */
        if (err) {
            return callback(err, response);
        }
        if (response.responseHeader.serviceResult !== StatusCodes.Good) {
            return callback(new Error(response.responseHeader.serviceResult.toString()));
        }
        assert(response instanceof write_service.WriteResponse);
        assert(nodesToWrite.length === response.results.length);
        callback(null, isArray ? response.results : response.results[0]);
    });
};


/**
 *
 * @method writeSingleNode
 * @async
 * @param nodeId  {NodeId}  - the node id of the node to write
 * @param value   {Variant} - the value to write
 * @param callback   {Function}
 * @param callback.err {object|null} the error if write has failed or null if OK
 * @param callback.statusCode {StatusCode} - the status code of the write
 *
 * @method writeSingleNode
 * @async
 * @param nodeId  {NodeId}  - the node id of the node to write
 * @param value   {Variant} - the value to write
 * @return {Promise<StatusCode>} - the status code of the write
 *
 */
ClientSession.prototype.writeSingleNode = function (nodeId, value, callback) {

    assert(_.isFunction(callback));

    var nodeToWrite = {
        nodeId: resolveNodeId(nodeId),
        attributeId: read_service.AttributeIds.Value,
        indexRange: null,
        value: new DataValue({value: value})
    };

    this.write(nodeToWrite, function (err, statusCode) {

        /* istanbul ignore next */
        if (err) {
            return callback(err);
        }
        assert(statusCode);
        callback(null, statusCode);
    });
};


var keys = Object.keys(read_service.AttributeIds).filter(function (k) {
    return k !== "INVALID";
});

function composeResult(nodes, nodesToRead, dataValues) {

    assert(nodesToRead.length === dataValues.length);
    var i = 0, c = 0;
    var results = [];
    var dataValue, k, nodeToRead;

    for (var n = 0; n < nodes.length; n++) {

        var node = nodes[n];


        var data = {};
        data.node = node;
        var addedProperty = 0;

        for (i = 0; i < keys.length; i++) {
            dataValue = dataValues[c];
            nodeToRead = nodesToRead[c];
            c++;
            if (dataValue.statusCode === StatusCodes.Good) {
                k = utils.lowerFirstLetter(keys[i]);
                data[k] = dataValue.value.value;
                addedProperty += 1;
            }
        }

        if (addedProperty > 0) {
            data.statusCode = StatusCodes.Good;
        } else {
            data.nodeId = resolveNodeId(node);
            data.statusCode = StatusCodes.BadNodeIdUnknown;
        }
        results.push(data);
    }

    return results;
}

/**
 * @method readAllAttributes
 *
 * @example:
 *
 *    ``` javascript
 *    session.readAllAttributes("ns=2;s=Furnace_1.Temperature",function(err,data) {
 *       if(data.statusCode === StatusCode.Good) {
 *          console.log(" nodeId      = ",data.nodeId.toString());
 *          console.log(" browseName  = ",data.browseName.toString());
 *          console.log(" description = ",data.description.toString());
 *          console.log(" value       = ",data.value.toString()));
 *
 *       }
 *    });
 *    ```
 *
 * @async
 * @param nodes                  {NodeId|NodeId[]} - nodeId to read or an array of nodeId to read
 * @param callback              {Function} - the callback function
 * @param callback.err                  {Error|null} - the error or null if the transaction was OK
 * @param callback.data                  {[]} a json object with the node attributes
 * @param callback.data.statusCode      {StatusCodes}
 * @param callback.data.nodeId          {NodeId}
 * @param callback.data.<attribute>     {*}
 *
 *
 */
ClientSession.prototype.readAllAttributes = function (nodes, callback) {

    assert(_.isFunction(callback));

    var isArray = _.isArray(nodes);
    if (!isArray) {
        nodes = [nodes];
    }

    var nodesToRead = [];

    nodes.forEach(function (node) {
        var nodeId = resolveNodeId(node);
        if (!nodeId) {
            throw new Error("cannot coerce " + node + " to a valid NodeId");
        }
        for (var i = 0; i < keys.length; i++) {
            var attributeId = read_service.AttributeIds[keys[i]];
            nodesToRead.push({
                nodeId: nodeId,
                attributeId: attributeId,
                indexRange: null,
                dataEncoding: {namespaceIndex: 0, name: null}
            });
        }
    });

    this.read(nodesToRead, function (err, dataValues) {
        if (err) return callback(err);
        var results = composeResult(nodes, nodesToRead, dataValues);
        callback(err, isArray ? results : results[0]);
    });

};

/**
 * @method read
 * @async
 * @param nodeToRead               {ReadValueId}
 * @param nodeToRead.nodeId        {NodeId|string}
 * @param nodeToRead.attributeId   {AttributeIds}
 * @param [maxAge]                 {Number}
 * @param callback                 {Function}                - the callback function
 * @param callback.err             {Error|null}              - the error or null if the transaction was OK}
 * @param callback.dataValue       {DataValue}
 *
 * @example:
 *
 * form2: reading a single node
 *
 *  ``` javascript
 *    var nodeToRead = {
*             nodeId:      "ns=2;s=Furnace_1.Temperature",
*             attributeId: AttributeIds.BrowseName
*    };
 *
 *    session.read(nodeToRead,function(err,dataValue) {
*        if (!err) {
*           console.log(dataValue.toString());
*        }
*    });
 *    ```
 *
 *
 * @method read
 * @async
 * @param nodesToRead               {Array<ReadValueId>} - an array of nodeId to read or a ReadValueId
 * @param [maxAge]                 {Number}
 * @param callback                 {Function}                - the callback function
 * @param callback.err             {Error|null}              - the error or null if the transaction was OK}
 * @param callback.dataValues       {Array<DataValue>}
 *
 * @example
 *
 *   ``` javascript
 *   var nodesToRead = [
 *        {
 *             nodeId:      "ns=2;s=Furnace_1.Temperature",
 *             attributeId: AttributeIds.BrowseName
 *        }
 *   ];
 *   session.read(nodesToRead,function(err,dataValues) {
 *     if (!err) {
 *       dataValues.forEach(dataValue=>console.log(dataValue.toString()));
 *     }
 *   });
 *   ```
 *
 * @method read
 * @async
 * @param nodeToRead               {ReadValueId}
 * @param nodeToRead.nodeId        {NodeId|string}
 * @param nodeToRead.attributeId   {AttributeIds}
 * @param [maxAge]                 {Number}
 * @return {Promise<DataValue>}
 *
 * @example:
 * @method read
 * @async
 * @param nodesToRead               {Array<ReadValueId>}
 * @param [maxAge]                  {Number}
 * @return {Promise<Array<DataValue>>}
 *
 */
ClientSession.prototype.read = function (nodesToRead, maxAge, callback) {

    var self = this;

    if (!callback) {
        callback = maxAge;
        maxAge = 0;
    }
    var isArray = _.isArray(nodesToRead);
    if (!isArray) {
        nodesToRead = [nodesToRead];
    }
    assert(_.isArray(nodesToRead));
    assert(_.isFunction(callback));

    if (helpAPIChange) {
        // the read method deprecation detection and warning
        if (!(getFunctionParameterNames(callback)[1] === "dataValues" || getFunctionParameterNames(callback)[1] === "dataValue")) {
            console.log("ERROR ClientSession#read  API has changed !!, please fix the client code".red);
            console.log("   replace ..:".red);
            console.log("   session.read(nodesToRead,function(err,nodesToRead,results) {}".cyan);
            console.log("   with .... :".red);
            console.log("   session.read(nodesToRead,function(err,dataValues) {}".cyan);
            console.log("");
            console.log("please make sure to refactor your code and check that he second argument of your callback function is named".yellow,("dataValue" + (isArray?"s":"")).cyan);
            console.log("to make this exception disappear".yellow);
            throw new Error("ERROR ClientSession#read  API has changed !!, please fix the client code");
        }
    }

    // coerce nodeIds
    nodesToRead.forEach(function (node) {
        node.nodeId = resolveNodeId(node.nodeId);
    });

    var request = new read_service.ReadRequest({
        nodesToRead: nodesToRead,
        maxAge: maxAge,
        timestampsToReturn: read_service.TimestampsToReturn.Both
    });

    self.performMessageTransaction(request, function (err, response) {

        /* istanbul ignore next */
        if (err) {
            return callback(err, response);
        }
        assert(response instanceof read_service.ReadResponse);

        const result =isArray? response.results : response.results[0];

        return callback(null,result);

    });
};


ClientSession.prototype.readDeprecated = function (nodesToRead, maxAge, callback) {
    assert(_.isArray(nodesToRead));
    this.read(nodesToRead, maxAge, function (err, results, diagnosticInfos) {
        callback(err, nodesToRead, results, diagnosticInfos);
    });
};

ClientSession.prototype.emitCloseEvent = function (statusCode) {


    var self = this;
    if (!self._closeEventHasBeenEmmitted) {
        debugLog("ClientSession#emitCloseEvent");
        self._closeEventHasBeenEmmitted = true;
        self.emit("session_closed", statusCode);
    }
};

ClientSession.prototype._defaultRequest = function (SomeRequest, SomeResponse, options, callback) {

    var self = this;

    assert(_.isFunction(callback));

    var request = new SomeRequest(options);

    /* istanbul ignore next */
    if (doDebug) {
        request.trace = new Error().stack;
    }

    self.performMessageTransaction(request, function (err, response) {

        /* istanbul ignore next */
        if (err) {
            // let intercept interesting error message
            if (err.message.match(/BadSessionClosed/)) {
                // the session has been closed by Server
                // probably due to timeout issue
                // let's print some statistics
                var now = new Date();
                debugLog(" server send BadSessionClosed !".bgWhite.red);
                debugLog(" timeout.................. ", self.timeout);
                debugLog(" lastRequestSentTime...... ", new Date(self.lastRequestSentTime).toISOString(), now - self.lastRequestSentTime);
                debugLog(" lastResponseReceivedTime. ", new Date(self.lastResponseReceivedTime).toISOString(), now - self.lastResponseReceivedTime);

                self._terminatePublishEngine();
                /**
                 * @event session_closed
                 * send when the session has been closed by the server ( proabably due to inactivity and timeout)
                 */
                self.emitCloseEvent(StatusCodes.BadSessionClosed);


            }
            return callback(err, response);
        }
        assert(response instanceof SomeResponse);
        callback(null, response);

    });
};

/**
 * @method createSubscription
 * @async
 *
 * @example:
 *
 *    ``` javascript
 *    session.createSubscription(request,function(err,response) {} );
 *    ```
 *
 * @param options {CreateSubscriptionRequest}
 * @param options.requestedPublishingInterval {Duration}
 * @param options.requestedLifetimeCount {Counter}
 * @param options.requestedMaxKeepAliveCount {Counter}
 * @param options.maxNotificationsPerPublish {Counter}
 * @param options.publishingEnabled {Boolean}
 * @param options.priority {Byte}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 * @param callback.response {CreateSubscriptionResponse} - the response
 */
ClientSession.prototype.createSubscription = function (options, callback) {

    var self = this;
    assert(_.isFunction(callback));

    var request = new subscription_service.CreateSubscriptionRequest(options);

    self.performMessageTransaction(request, function (err, response) {

        /* istanbul ignore next */
        if (err) {
            return callback(err, response);
        }
        assert(response instanceof subscription_service.CreateSubscriptionResponse);
        callback(null, response);
    });
};

/**
 * @method deleteSubscriptions
 * @async
 * @example:
 *
 *     session.deleteSubscriptions(request,function(err,response) {} );
 *
 * @param options {DeleteSubscriptionsRequest}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 * @param callback.response {DeleteSubscriptionsResponse} - the response
 */
ClientSession.prototype.deleteSubscriptions = function (options, callback) {
    this._defaultRequest(
        subscription_service.DeleteSubscriptionsRequest,
        subscription_service.DeleteSubscriptionsResponse,
        options, callback);
};

/**
 * @method transferSubscriptions
 *
 * @async
 * @param options {TransferSubscriptionsRequest}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 * @param callback.response {TransferSubscriptionsResponse} - the response
 */
ClientSession.prototype.transferSubscriptions = function (options, callback) {
    this._defaultRequest(
        subscription_service.TransferSubscriptionsRequest,
        subscription_service.TransferSubscriptionsResponse,
        options, callback);
};

/**
 *
 * @method createMonitoredItems
 * @async
 * @param options  {CreateMonitoredItemsRequest}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 * @param callback.response {CreateMonitoredItemsResponse} - the response
 */
ClientSession.prototype.createMonitoredItems = function (options, callback) {
    this._defaultRequest(
        subscription_service.CreateMonitoredItemsRequest,
        subscription_service.CreateMonitoredItemsResponse,
        options, callback);
};

/**
 *
 * @method modifyMonitoredItems
 * @async
 * @param options {ModifyMonitoredItemsRequest}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 * @param callback.response {ModifyMonitoredItemsResponse} - the response
 */
ClientSession.prototype.modifyMonitoredItems = function (options, callback) {
    this._defaultRequest(
        subscription_service.ModifyMonitoredItemsRequest,
        subscription_service.ModifyMonitoredItemsResponse,
        options, callback);
};

/**
 *
 * @method modifySubscription
 * @async
 * @param options {ModifySubscriptionRequest}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 * @param callback.response {ModifySubscriptionResponse} - the response
 */
ClientSession.prototype.modifySubscription = function (options, callback) {
    this._defaultRequest(
        subscription_service.ModifySubscriptionRequest,
        subscription_service.ModifySubscriptionResponse,
        options, callback);
};

ClientSession.prototype.setMonitoringMode = function (options, callback) {
    this._defaultRequest(
        subscription_service.SetMonitoringModeRequest,
        subscription_service.SetMonitoringModeResponse,
        options, callback);
};

/**
 *
 * @method publish
 * @async
 * @param options  {PublishRequest}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 * @param callback.response {PublishResponse} - the response
 */
ClientSession.prototype.publish = function (options, callback) {
    this._defaultRequest(
        subscription_service.PublishRequest,
        subscription_service.PublishResponse,
        options, callback);
};

/**
 *
 * @method republish
 * @async
 * @param options  {RepublishRequest}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 * @param callback.response {RepublishResponse} - the response
 */
ClientSession.prototype.republish = function (options, callback) {
    this._defaultRequest(
        subscription_service.RepublishRequest,
        subscription_service.RepublishResponse,
        options, callback);
};

/**
 *
 * @method deleteMonitoredItems
 * @async
 * @param options  {DeleteMonitoredItemsRequest}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 */
ClientSession.prototype.deleteMonitoredItems = function (options, callback) {
    this._defaultRequest(
        subscription_service.DeleteMonitoredItemsRequest,
        subscription_service.DeleteMonitoredItemsResponse,
        options, callback);
};

/**
 *
 * @method setPublishingMode
 * @async
 * @param publishingEnabled  {Boolean}
 * @param subscriptionIds {Array<Integer>}
 * @param callback {Function}
 * @param callback.err {Error|null}   - the Error if the async method has failed
 */
ClientSession.prototype.setPublishingMode = function (publishingEnabled, subscriptionIds, callback) {

    var self = this;
    assert(_.isFunction(callback));
    assert(publishingEnabled === true || publishingEnabled === false);
    if (!_.isArray(subscriptionIds)) {
        assert(_.isNumber(subscriptionIds));
        subscriptionIds = [subscriptionIds];
    }

    var request = new subscription_service.SetPublishingModeRequest({
        publishingEnabled: publishingEnabled,
        subscriptionIds: subscriptionIds
    });

    self.performMessageTransaction(request, function (err, response) {

        /* istanbul ignore next */
        if (err) {
            return callback(err, null);
        }

        callback(err, response.results);

    });
};

/**
 *
 * @method translateBrowsePath
 * @async
 * @param browsePath {BrowsePath|Array<BrowsePath>}
 * @param callback {Function}
 * @param callback.err {Error|null}
 * @param callback.response {BrowsePathResult|Array<BrowsePathResult>}
 *
 *
 *
 */
ClientSession.prototype.translateBrowsePath = function (browsePath, callback) {
    assert(_.isFunction(callback));
    var self = this;

    var translate_service = require("node-opcua-service-translate-browse-path");

    var  isArray = _.isArray(browsePath);
    browsePath = isArray ?  browsePath :[browsePath];

    var request = new translate_service.TranslateBrowsePathsToNodeIdsRequest({
        browsePath: browsePath
    });

    self.performMessageTransaction(request, function (err, response) {

        /* istanbul ignore next */
        if (err) {
            return callback(err, response);
        }
        assert(response instanceof translate_service.TranslateBrowsePathsToNodeIdsResponse);
        callback(null, isArray ? response.results : response.results[0]);

    });

};

ClientSession.prototype.isChannelValid = function () {
    var self = this;
    assert(self._client);
    return self._client._secureChannel && self._client._secureChannel.isOpened();
};

ClientSession.prototype.performMessageTransaction = function (request, callback) {

    var self = this;

    assert(_.isFunction(callback));
    assert(self._client);

    if (!self.isChannelValid()) {
        // we need to queue this transaction, as a secure token may be being reprocessed
        console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! ".bgWhite.red);
        return callback(new Error("Invalid Channel "));
    }
    request.requestHeader.authenticationToken = this.authenticationToken;

    self.lastRequestSentTime = Date.now();

    self._client.performMessageTransaction(request, function (err, response) {

        self.lastResponseReceivedTime = Date.now();

        /* istanbul ignore next */
        if (err) {
            if (response && response.diagnosticInfo) {
                err.diagnosticInfo = response.diagnosticInfo;
            }
            return callback(err, response);
        }

        if (response.responseHeader.serviceResult !== StatusCodes.Good) {
            err = new Error(" ServiceResult is " + response.responseHeader.serviceResult.toString());
            if (response && response.diagnosticInfo) {
                err.diagnosticInfo = response.diagnosticInfo;
            }
        }
        callback(err, response);
    });
};

ClientSession.prototype._terminatePublishEngine = function () {
    if (this._publishEngine) {
        this._publishEngine.terminate();
        this._publishEngine = null;
    }
};

/**
 *
 * @method close
 * @async
 * @param [deleteSubscription=true] {Boolean}
 * @param callback {Function}
 */
ClientSession.prototype.close = function (deleteSubscription, callback) {

    if (arguments.length === 1) {
        callback = deleteSubscription;
        deleteSubscription = true;
    }
    assert(_.isFunction(callback));
    assert(_.isBoolean(deleteSubscription));
    assert(this._client);

    this._terminatePublishEngine();
    this._client.closeSession(this, deleteSubscription, callback);

};

/**
 * @method hasBeenClosed
 * @return {Boolean}
 */
ClientSession.prototype.hasBeenClosed = function () {
    return utils.isNullOrUndefined(this._client) || this._closed;
};

/**
 *
 * @method call
 *
 * @param methodToCall {CallMethodRequest} the call method request
 * @param callback {Function}
 * @param callback.err {Error|null}
 * @param callback.response {CallMethodResult}
 *
 * @example :
 *
 * var methodToCall = {
 *     objectId: "ns=2;i=12",
 *     methodId: "ns=2;i=13",
 *     inputArguments: [
 *         new Variant({...}),
 *         new Variant({...}),
 *     ]
 * }
 * session.call(methodToCall,function(err,callResult) {
 *    if (!err) {
 *         console.log(" statusCode = ",callResult.statusCode);
 *         console.log(" inputArgumentResults[0] = ",callResult.inputArgumentResults[0].toString());
 *         console.log(" inputArgumentResults[1] = ",callResult.inputArgumentResults[1].toString());
 *         console.log(" outputArgument[0]       = ",callResult.outputArgument[0].toString()); // array of variant
 *    }
 * });
 *
 * @method call
 *
 * @param methodsToCall {CallMethodRequest[]} the call method request array
 * @param callback {Function}
 * @param callback.err {Error|null}
 * @param callback.response {CallMethodResult[]}
 *
 *
 * @example :
 *
 * var methodsToCall = [ {
 *     objectId: "ns=2;i=12",
 *     methodId: "ns=2;i=13",
 *     inputArguments: [
 *         new Variant({...}),
 *         new Variant({...}),
 *     ]
 * }];
 * session.call(methodsToCall,function(err,callResutls) {
 *    if (!err) {
 *         var callResult = callResutls[0];
 *         console.log(" statusCode = ",rep.statusCode);
 *         console.log(" inputArgumentResults[0] = ",callResult.inputArgumentResults[0].toString());
 *         console.log(" inputArgumentResults[1] = ",callResult.inputArgumentResults[1].toString());
 *         console.log(" outputArgument[0]       = ",callResult.outputArgument[0].toString()); // array of variant
 *    }
 * });
 */
ClientSession.prototype.call = function (methodsToCall, callback) {

    var self = this;

    var isArray = _.isArray(methodsToCall);
    if (!isArray) { methodsToCall = [methodsToCall]; }

    assert(_.isArray(methodsToCall));

    // Note : The client has no explicit address space and therefore will struggle to
    //        access the method arguments signature.
    //        There are two methods that can be considered:
    //           - get the object definition by querying the server
    //           - load a fake address space to have some thing to query on our end
    // var request = self._client.factory.constructObjectId("CallRequest",{ methodsToCall: methodsToCall});
    var request = new call_service.CallRequest({methodsToCall: methodsToCall});

    self.performMessageTransaction(request, function (err, response) {

        /* istanbul ignore next */
        if (err) {
            return callback(err);
        }
        assert(response instanceof call_service.CallResponse);
        callback(null, isArray ? response.results : response.results[0]);

    });

};

var emptyUint32Array = new Uint32Array(0);

/**
 * @method getMonitoredItems
 * @param subscriptionId {UInt32} the subscription Id to return
 * @param callback {Function}
 * @param callback.err {Error}
 * @param callback.monitoredItems the monitored Items
 * @param callback.monitoredItems the monitored Items
 */
ClientSession.prototype.getMonitoredItems = function (subscriptionId, callback) {

    // <UAObject NodeId="i=2253"  BrowseName="Server">
    // <UAMethod NodeId="i=11492" BrowseName="GetMonitoredItems" ParentNodeId="i=2253" MethodDeclarationId="i=11489">
    // <UAMethod NodeId="i=11489" BrowseName="GetMonitoredItems" ParentNodeId="i=2004">
    var self = this;
    var methodsToCall =
        new call_service.CallMethodRequest({
            objectId: coerceNodeId("ns=0;i=2253"),  // ObjectId.Server
            methodId: coerceNodeId("ns=0;i=11492"), // MethodIds.Server_GetMonitoredItems;
            inputArguments: [
                // BaseDataType
                {dataType: DataType.UInt32, value: subscriptionId}
            ]
        });

    self.call([methodsToCall], function (err, result) {

            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }

            result = result[0];

            if (result.statusCode !== StatusCodes.Good) {

                callback(new Error(result.statusCode.toString()), result);

            } else {

                assert(result.outputArguments.length === 2);
                var data = {
                    serverHandles: result.outputArguments[0].value, //
                    clientHandles: result.outputArguments[1].value
                };

                // Note some server might return null array
                // let make sure we have Uint32Array and not a null pointer
                data.serverHandles = data.serverHandles || emptyUint32Array;
                data.clientHandles = data.clientHandles || emptyUint32Array;

                assert(data.serverHandles instanceof Uint32Array);
                assert(data.clientHandles instanceof Uint32Array);
                callback(null, data);
            }
        }
    );
};


/**
 * @method getArgumentDefinition
 *    extract the argument definition of a method
 * @param methodId {NodeId}
 * @param callback  {Function}
 * @param {Error|null} callback.err
 * @param [object} callback.args
 * @param {Argument<>} callback.args.inputArguments
 * @param {Argument<>} callback.args.outputArguments
 * @async
 *
 * @method getArgumentDefinition
 * @param  methodId {NodeId}
 * @return {Promise<obj>}  {inputArguments: .., outputArguments: ...}
 * @async
 *
 */
ClientSession.prototype.getArgumentDefinition = function (methodId, callback) {

    assert(_.isFunction(callback));
    assert(methodId instanceof NodeId);
    var session = this;

    var browseDescription = new browse_service.BrowseDescription({
        nodeId: methodId,
        referenceTypeId: resolveNodeId("HasProperty"),
        browseDirection: BrowseDirection.Forward,
        nodeClassMask: 0,// makeNodeClassMask("Variable"),
        includeSubtypes: true,
        resultMask: makeResultMask("BrowseName")
    });

    //Xx console.log("xxxx browseDescription", util.inspect(browseDescription, {colors: true, depth: 10}));
    session.browse(browseDescription, function (err, browseResult) {

        /* istanbul ignore next */
        if (err) {
            return callback(err);
        }
        browseResult.references = browseResult.references || [];

        //xx console.log("xxxx results", util.inspect(results, {colors: true, depth: 10}));
        var inputArgumentRef = browseResult.references.filter(function (r) {
            return r.browseName.name === "InputArguments";
        });

        // note : InputArguments property is optional thus may be missing
        inputArgumentRef = (inputArgumentRef.length === 1) ? inputArgumentRef[0] : null;

        var outputArgumentRef = browseResult.references.filter(function (r) {
            return r.browseName.name === "OutputArguments";
        });

        // note : OutputArguments property is optional thus may be missing
        outputArgumentRef = (outputArgumentRef.length === 1) ? outputArgumentRef[0] : null;

        //xx console.log("xxxx argument", util.inspect(argument, {colors: true, depth: 10}));
        //xx console.log("xxxx argument nodeId", argument.nodeId.toString());

        var inputArguments = [], outputArguments = [];

        var nodesToRead = [];
        var actions = [];

        if (inputArgumentRef) {
            nodesToRead.push({
                nodeId: inputArgumentRef.nodeId,
                attributeId: read_service.AttributeIds.Value
            });
            actions.push(function (result) {
                inputArguments = result.value.value;
            });
        }
        if (outputArgumentRef) {
            nodesToRead.push({
                nodeId: outputArgumentRef.nodeId,
                attributeId: read_service.AttributeIds.Value
            });
            actions.push(function (result) {
                outputArguments = result.value.value;
            });
        }

        if (nodesToRead.length === 0) {
            return callback(null, { inputArguments, outputArguments });
        }
        // now read the variable
        session.read(nodesToRead, function (err, dataValues) {

            /* istanbul ignore next */
            if (err) {
                return callback(err);
            }

            dataValues.forEach(function (result, index) {
                actions[index].call(null, result);
            });

            //xx console.log("xxxx result", util.inspect(result, {colors: true, depth: 10}));
            callback(null, { inputArguments, outputArguments });
        });

    });
};

/**
 * the endpoint on which this session is operating
 * @property endpoint
 * @type {EndpointDescription}
 */
ClientSession.prototype.__defineGetter__("endpoint", function () {
    return this._client.endpoint;
});

var register_node_service = require("node-opcua-service-register-node");
/**
 *
 */
ClientSession.prototype.registerNodes = function(nodesToRegister,callback) {
    var self = this;
    assert(_.isFunction(callback));
    assert(_.isArray(nodesToRegister));

    var request = new register_node_service.RegisterNodesRequest({
        nodesToRegister: nodesToRegister.map(resolveNodeId)
    });

    self.performMessageTransaction(request, function (err, response) {
        /* istanbul ignore next */
        if (err) {
            return callback(err);
        }
        assert(response instanceof register_node_service.RegisterNodesResponse);
        callback(null, response.registeredNodeIds);
    });

};

ClientSession.prototype.unregisterNodes = function(nodesToRegister,callback) {
    var self = this;
    assert(_.isFunction(callback));
    assert(_.isArray(nodesToUnregister));

    var request = new register_node_service.UnregisterNodesRequest({
        nodesToUnregister: nodesToUnregister.map(resolveNodeId)
    });

    self.performMessageTransaction(request, function (err, response) {
        /* istanbul ignore next */
        if (err) {
            return callback(err);
        }
        assert(response instanceof register_node_service.UnregisterNodesResponse);
        callback(null);
    });
};

var query_service = require("node-opcua-service-query");
/**
 * @method queryFirst
 * @param queryFirstRequest {queryFirstRequest}
 * @param callback {Function}
 * @param callback.err {Error|null}
 * @param callback.response {queryFirstResponse}
 *
 */
ClientSession.prototype.queryFirst = function (queryFirstRequest, callback) {
    var self = this;
    assert(_.isFunction(callback));

    var request = new query_service.QueryFirstRequest(queryFirstRequest);

    self.performMessageTransaction(request, function (err, response) {
        /* istanbul ignore next */
        if (err) {
            return callback(err);
        }
        assert(response instanceof query_service.QueryFirstResponse);
        callback(null, response.results);
    });
};

var ClientSessionKeepAliveManager = require("./client_session_keepalive_manager").ClientSessionKeepAliveManager;

ClientSession.prototype.startKeepAliveManager = function () {
    var self = this;
    assert(!self._keepAliveManager, "keepAliveManger already started");
    self._keepAliveManager = new ClientSessionKeepAliveManager(this);


    self._keepAliveManager.on("failure", function () {
        self.stopKeepAliveManager();
        /**
         * raised when a keep-alive request has failed on the session, may be the session has timeout
         * unexpectidaly on the server side, may be the connection is broken.
         * @event keepalive_failure
         */
        self.emit("keepalive_failure");
    });
    self._keepAliveManager.on("keepalive", function (state) {
        /**
         * @event keepalive
         */
        self.emit("keepalive", state);
    });
    self._keepAliveManager.start();
};

ClientSession.prototype.stopKeepAliveManager = function () {
    var self = this;
    if (self._keepAliveManager) {
        self._keepAliveManager.stop();
        self._keepAliveManager = null;
    }
};

ClientSession.prototype.dispose = function () {
    assert(this._closeEventHasBeenEmmitted);
    this._terminatePublishEngine();
    this.stopKeepAliveManager();
    this.removeAllListeners();
};

ClientSession.prototype.toString = function () {

    var now = Date.now();
    var session = this;
    console.log(" name..................... ", session.name);
    console.log(" sessionId................ ", session.sessionId);
    console.log(" authenticationToken...... ", session.authenticationToken);
    console.log(" timeout.................. ", session.timeout);
    console.log(" serverNonce.............. ", session.serverNonce.toString("hex"));
    console.log(" serverCertificate........ ", session.serverCertificate.toString("base64"));
    console.log(" serverSignature.......... ", session.serverSignature);
    console.log(" lastRequestSentTime...... ", new Date(session.lastRequestSentTime).toISOString(), now - session.lastRequestSentTime);
    console.log(" lastResponseReceivedTime. ", new Date(session.lastResponseReceivedTime).toISOString(), now - session.lastResponseReceivedTime);
};


var AttributeIds = require("node-opcua-data-model").AttributeIds;
var ReferenceTypeIds = require("node-opcua-constants").ReferenceTypeIds;
var makeNodeId = require("node-opcua-nodeid").makeNodeId;
var resultMask = makeResultMask("ReferenceType");

function __findBasicDataType(session, dataTypeId, callback) {

    assert(dataTypeId instanceof NodeId);

    if (dataTypeId.value <= 25) {
        // we have a well-known DataType
        var dataType = DataType.get(dataTypeId.value);
        callback(null, dataType);
    } else {

        // let's browse for the SuperType of this object
        var nodeToBrowse = new browse_service.BrowseDescription({
            referenceTypeId: makeNodeId(ReferenceTypeIds.HasSubtype),
            includeSubtypes: false,
            browseDirection: BrowseDirection.Inverse,
            nodeId: dataTypeId,
            resultMask: resultMask
        });

        session.browse(nodeToBrowse, function (err, browseResult) {
            if (err) return callback(err);
            var baseDataType = browseResult.references[0].nodeId;
            return __findBasicDataType(session, baseDataType, callback);
        });
    }
}

/**
 * @method getBuiltInDataType
 * retrieve the built-in DataType of a Variable, from its DataType attribute
 * useful to determine which DataType to use when constructing a Variant
 * @param nodeId {NodeId} the node id of the variable to query
 * @param callback {Function} the callback function
 * @param callback.err
 * @param callback.result {DataType}
 * @async
 *
 *
 * @example
 *     var session = ...; // ClientSession
 *     var nodeId = opcua.VariableIds.Server_ServerStatus_CurrentTime;
 *     session.getBuildInDataType(nodeId,function(err,dataType) {
 *        assert(dataType === opcua.DataType.DateTime);
 *     });
 *     // or
 *     nodeId = opcua.coerceNodeId("ns=411;s=Scalar_Static_ImagePNG");
 *     session.getBuildInDataType(nodeId,function(err,dataType) {
 *        assert(dataType === opcua.DataType.ByteString);
 *     });
 *
 */
ClientSession.prototype.getBuiltInDataType = function (nodeId, callback) {

    var dataTypeId = null;
    var session = this;
    var nodeToRead = {
        nodeId: nodeId,
        attributeId: AttributeIds.DataType
    };
    session.read(nodeToRead, 0, function (err, dataValue) {
        if (err) return callback(err);
        if (dataValue.statusCode !== StatusCodes.Good) {
            return callback(new Error("cannot read DataType Attribute " + dataValue.statusCode.toString()));
        }
        dataTypeId = dataValue.value.value;
        assert(dataTypeId instanceof NodeId);
        __findBasicDataType(session, dataTypeId, callback);
    });

};

ClientSession.prototype.resumePublishEngine = function () {
    var self = this;

    if (self._publishEngine.subscriptionCount > 0) {
        self._publishEngine.replenish_publish_request_queue();
    }
};

exports.ClientSession = ClientSession;



var thenify = require("thenify");
var opts = { multiArgs : false };
ClientSession.prototype.browse                = thenify.withCallback(ClientSession.prototype.browse,opts);
ClientSession.prototype.readVariableValue     = thenify.withCallback(ClientSession.prototype.readVariableValue,opts);
ClientSession.prototype.readHistoryValue      = thenify.withCallback(ClientSession.prototype.readHistoryValue,opts);
ClientSession.prototype.write                 = thenify.withCallback(ClientSession.prototype.write,opts);
ClientSession.prototype.writeSingleNode       = thenify.withCallback(ClientSession.prototype.writeSingleNode,opts);
ClientSession.prototype.readAllAttributes     = thenify.withCallback(ClientSession.prototype.readAllAttributes,opts);
ClientSession.prototype.read                  = thenify.withCallback(ClientSession.prototype.read,opts);
ClientSession.prototype.createSubscription    = thenify.withCallback(ClientSession.prototype.createSubscription,opts);
ClientSession.prototype.deleteSubscriptions   = thenify.withCallback(ClientSession.prototype.deleteSubscriptions,opts);
ClientSession.prototype.transferSubscriptions = thenify.withCallback(ClientSession.prototype.transferSubscriptions,opts);
ClientSession.prototype.createMonitoredItems  = thenify.withCallback(ClientSession.prototype.createMonitoredItems,opts);
ClientSession.prototype.modifyMonitoredItems  = thenify.withCallback(ClientSession.prototype.modifyMonitoredItems,opts);
ClientSession.prototype.modifySubscription    = thenify.withCallback(ClientSession.prototype.modifySubscription,opts);
ClientSession.prototype.setMonitoringMode     = thenify.withCallback(ClientSession.prototype.setMonitoringMode,opts);
ClientSession.prototype.publish               = thenify.withCallback(ClientSession.prototype.publish,opts);
ClientSession.prototype.republish             = thenify.withCallback(ClientSession.prototype.republish,opts);
ClientSession.prototype.deleteMonitoredItems  = thenify.withCallback(ClientSession.prototype.deleteMonitoredItems,opts);
ClientSession.prototype.setPublishingMode     = thenify.withCallback(ClientSession.prototype.setPublishingMode,opts);
ClientSession.prototype.translateBrowsePath   = thenify.withCallback(ClientSession.prototype.translateBrowsePath,opts);
ClientSession.prototype.performMessageTransaction= thenify.withCallback(ClientSession.prototype.performMessageTransaction,opts);
ClientSession.prototype.close                 = thenify.withCallback(ClientSession.prototype.close,opts);
ClientSession.prototype.call                  = thenify.withCallback(ClientSession.prototype.call,opts);
ClientSession.prototype.getMonitoredItems     = thenify.withCallback(ClientSession.prototype.getMonitoredItems,opts);
ClientSession.prototype.getArgumentDefinition = thenify.withCallback(ClientSession.prototype.getArgumentDefinition,opts);
ClientSession.prototype.queryFirst            = thenify.withCallback(ClientSession.prototype.queryFirst,opts);
ClientSession.prototype.registerNodes         = thenify.withCallback(ClientSession.prototype.registerNodes,opts);
ClientSession.prototype.unregisterNodes       = thenify.withCallback(ClientSession.prototype.unregisterNodes,opts);
