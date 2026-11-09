const {callCloud}=require('./cloud');
module.exports = (action,data) => callCloud('savingsApi',action,data);
