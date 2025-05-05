const express = require('express');
const router = express.Router();
const subscriptionController = require("../../controllers/subscriptionController");

router.post('/create/session', subscriptionController.createCheckoutSession);
router.post('/verify/payment', subscriptionController.verifyPayment);
router.post('/cancel', subscriptionController.cancelSubscription);
router.get('/list', subscriptionController.listSubscriptions);  

module.exports = router;