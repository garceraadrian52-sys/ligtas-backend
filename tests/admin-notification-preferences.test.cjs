const {test}=require('node:test');
const assert=require('node:assert/strict');
const {allowsAdminNotification}=require('../dist/services/adminNotificationPreferences');
test('inbox master and category settings control actual future deliveries without disabling unrelated categories',()=>{
 assert.equal(allowsAdminNotification({},'alert','Critical'),true);
 assert.equal(allowsAdminNotification({notifications:{push:false}},'alert','High'),false);
 assert.equal(allowsAdminNotification({notifications:{push:false}},'report'),false);
 assert.equal(allowsAdminNotification({notifications:{critical:false}},'alert','Critical'),false);
 assert.equal(allowsAdminNotification({notifications:{critical:false}},'alert','High'),true);
 assert.equal(allowsAdminNotification({notifications:{reports:false}},'report'),false);
 assert.equal(allowsAdminNotification({notifications:{reports:false}},'alert','Critical'),true);
});
