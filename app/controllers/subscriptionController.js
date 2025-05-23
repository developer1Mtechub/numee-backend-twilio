const Stripe = require("stripe");
require("dotenv").config();
const nodemailer = require("nodemailer");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USERNAME,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Create a Stripe Checkout Session
exports.createCheckoutSession = async (req, res) => {
  try {
    const { priceId, email } = req.body; // Price ID from Stripe Dashboard

    // const origin = req.headers.origin || 'http://192.168.18.142:3022';  // Fallback to localhost if origin is undefined
    const origin =
      req.headers.origin ||
      "https://numee-app-backend.caprover-testing.mtechub.com"; // Fallback to localhost if origin is undefined

    // Check if a customer already exists with the given email
    let customer;
    const customers = await stripe.customers.list({
      email: email, // Search for customers with the provided email
      limit: 1, // Only need one result
    });

    if (customers.data.length > 0) {
      // Customer exists, use the existing customer ID
      customer = customers.data[0];

      // Check if the customer already has an active subscription
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: "active", // Check only for active subscriptions
        limit: 1, // We only need to check for one active subscription
      });

      // if (subscriptions.data.length > 0) {
      //     // If the customer has an active subscription, prevent further checkout creation
      //     return res.json({
      //         success: false,
      //         message: 'Customer already has an active subscription.',
      //     });
      // }
    } else {
      // Customer doesn't exist, create a new one
      customer = await stripe.customers.create({
        email: email,
      });
    }

    // Create the checkout session with the customer ID
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer: customer.id, // Use existing or newly created customer ID
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`, // Use origin or fallback URL
      cancel_url: `${origin}/cancel`, // Use origin or fallback URL
    });

    // await transporter.sendMail({
    //     from: process.env.EMAIL_USERNAME,
    //     to: email,
    //     subject: 'Checkout Session Created',
    //     html: `
    //             <!DOCTYPE html>
    //             <html>
    //             <head>
    //                 <meta charset="UTF-8">
    //                 <meta name="viewport" content="width=device-width, initial-scale=1.0">
    //                 <title>Subscription Confirmation</title>
    //                 <style>
    //                     body {
    //                         font-family: Arial, sans-serif;
    //                         margin: 0;
    //                         padding: 0;
    //                         background-color: #f4f4f4;
    //                     }
    //                     .email-container {
    //                         background-color: #ffffff;
    //                         margin: 20px auto;
    //                         padding: 20px;
    //                         border-radius: 8px;
    //                         box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    //                         max-width: 600px;
    //                     }
    //                     .header {
    //                         text-align: center;
    //                     }
    //                     .header img {
    //                         width: 120px;
    //                     }
    //                     .content {
    //                         margin: 20px 0;
    //                         text-align: center;
    //                     }
    //                     .content h1 {
    //                         color: #333333;
    //                     }
    //                     .content p {
    //                         color: #666666;
    //                         font-size: 16px;
    //                         margin: 10px 0;
    //                     }
    //                     .cta-button {
    //                         display: inline-block;
    //                         background-color: #4CAF50;
    //                         color: white;
    //                         text-decoration: none;
    //                         padding: 12px 24px;
    //                         margin: 20px 0;
    //                         border-radius: 5px;
    //                         font-weight: bold;
    //                     }
    //                     .footer {
    //                         text-align: center;
    //                         margin-top: 30px;
    //                         font-size: 12px;
    //                         color: #999999;
    //                     }
    //                     .social-icons {
    //                         margin: 20px 0;
    //                         text-align: center;
    //                     }
    //                     .social-icons a {
    //                         margin: 0 10px;
    //                         display: inline-block;
    //                     }
    //                     .social-icons img {
    //                         width: 24px;
    //                         height: 24px;
    //                     }
    //                 </style>
    //             </head>
    //             <body>
    //                 <div class="email-container">
    //                     <div class="header">
    //                         <img src="https://res.cloudinary.com/ddorrmob5/image/upload/v1736338301/hoifnqb1bwmdhmunidug.png" alt="Company Logo">
    //                     </div>
    //                     <div class="content">
    //                         <h1>🎉 Subscription Created Successfully!</h1>
    //                         <p>Hello,</p>
    //                         <p>Your subscription has been successfully created. Enjoy uninterrupted access to our premium services!</p>
    //                         <p><strong>Subscription Valid till 1 month</strong></p>
    //                     </div>
    //                     <div class="social-icons">
    //                         <a href="https://www.facebook.com/"><img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook"></a>
    //                         <a href="https://twitter.com/"><img src="https://cdn-icons-png.flaticon.com/512/733/733579.png" alt="Twitter"></a>
    //                         <a href="https://instagram.com/"><img src="https://cdn-icons-png.flaticon.com/512/733/733558.png" alt="Instagram"></a>
    //                     </div>
    //                     <div class="footer">
    //                         <p>&copy; ${new Date().getFullYear()} Nummy. All rights reserved.</p>
    //                         <p><a href="https://yourwebsite.com/privacy-policy">Privacy Policy</a> | <a href="https://yourwebsite.com/terms">Terms of Service</a></p>
    //                     </div>
    //                 </div>
    //             </body>
    //             </html>
    //         `,
    // });

    // res.render('success', {
    //     session_id: session.id,
    //     payment_status: true, // Assuming successful creation implies true
    // });

    res.json({
      success: true,
      message: "Checkout session created successfully",
      data: { url: session.url },
    });
  } catch (error) {
    console.error("Error creating checkout session:", error);

    // await transporter.sendMail({
    //     from: process.env.EMAIL_USERNAME,
    //     to: email,
    //     subject: 'Subscription Failed',
    //     html: `
    //             <!DOCTYPE html>
    //             <html>
    //             <head>
    //                 <meta charset="UTF-8">
    //                 <meta name="viewport" content="width=device-width, initial-scale=1.0">
    //                 <title>Subscription Confirmation</title>
    //                 <style>
    //                     body {
    //                         font-family: Arial, sans-serif;
    //                         margin: 0;
    //                         padding: 0;
    //                         background-color: #f4f4f4;
    //                     }
    //                     .email-container {
    //                         background-color: #ffffff;
    //                         margin: 20px auto;
    //                         padding: 20px;
    //                         border-radius: 8px;
    //                         box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    //                         max-width: 600px;
    //                     }
    //                     .header {
    //                         text-align: center;
    //                     }
    //                     .header img {
    //                         width: 120px;
    //                     }
    //                     .content {
    //                         margin: 20px 0;
    //                         text-align: center;
    //                     }
    //                     .content h1 {
    //                         color: #333333;
    //                     }
    //                     .content p {
    //                         color: #666666;
    //                         font-size: 16px;
    //                         margin: 10px 0;
    //                     }
    //                     .cta-button {
    //                         display: inline-block;
    //                         background-color: #4CAF50;
    //                         color: white;
    //                         text-decoration: none;
    //                         padding: 12px 24px;
    //                         margin: 20px 0;
    //                         border-radius: 5px;
    //                         font-weight: bold;
    //                     }
    //                     .footer {
    //                         text-align: center;
    //                         margin-top: 30px;
    //                         font-size: 12px;
    //                         color: #999999;
    //                     }
    //                     .social-icons {
    //                         margin: 20px 0;
    //                         text-align: center;
    //                     }
    //                     .social-icons a {
    //                         margin: 0 10px;
    //                         display: inline-block;
    //                     }
    //                     .social-icons img {
    //                         width: 24px;
    //                         height: 24px;
    //                     }
    //                 </style>
    //             </head>
    //             <body>
    //                 <div class="email-container">
    //                     <div class="header">
    //                         <img src="https://res.cloudinary.com/ddorrmob5/image/upload/v1736338301/hoifnqb1bwmdhmunidug.png" alt="Company Logo">
    //                     </div>
    //                     <div class="content">
    //                         <h1>⚠️ Subscription Failed!</h1>
    //                         <p>Sorry,</p>
    //                         <p>Your subscription could not be processed. Please try again or contact our support team!</p>
    //                     </div>
    //                     <div class="social-icons">
    //                         <a href="https://www.facebook.com/"><img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook"></a>
    //                         <a href="https://twitter.com/"><img src="https://cdn-icons-png.flaticon.com/512/733/733579.png" alt="Twitter"></a>
    //                         <a href="https://instagram.com/"><img src="https://cdn-icons-png.flaticon.com/512/733/733558.png" alt="Instagram"></a>
    //                     </div>
    //                     <div class="footer">
    //                         <p>&copy; ${new Date().getFullYear()} Nummy. All rights reserved.</p>
    //                         <p><a href="https://yourwebsite.com/privacy-policy">Privacy Policy</a> | <a href="https://yourwebsite.com/terms">Terms of Service</a></p>
    //                     </div>
    //                 </div>
    //             </body>
    //             </html>
    //         `,
    // });

    await transporter.sendMail({
      from: process.env.EMAIL_USERNAME,
      to: email,
      subject: "Subscription Failed",
      html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Subscription Confirmation</title>
                        <style>
                            body {
                                font-family: Arial, sans-serif;
                                margin: 0;
                                padding: 0;
                                background-color: #f4f4f4;
                            }
                            .email-container {
                                background-color: #ffffff;
                                margin: 20px auto;
                                padding: 20px;
                                border-radius: 8px;
                                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                                max-width: 600px;
                            }
                            .header {
                                text-align: center;
                            }
                            .header img {
                                width: 120px;
                            }
                            .content {
                                margin: 20px 0;
                                text-align: center;
                            }
                            .content h1 {
                                color: #333333;
                            }
                            .content p {
                                color: #666666;
                                font-size: 16px;
                                margin: 10px 0;
                            }
                            .cta-button {
                                display: inline-block;
                                background-color: #4CAF50;
                                color: white;
                                text-decoration: none;
                                padding: 12px 24px;
                                margin: 20px 0;
                                border-radius: 5px;
                                font-weight: bold;
                            }
                            .footer {
                                text-align: center;
                                margin-top: 30px;
                                font-size: 12px;
                                color: #999999;
                            }
                            .social-icons {
                                margin: 20px 0;
                                text-align: center;
                            }
                            .social-icons a {
                                margin: 0 10px;
                                display: inline-block;
                            }
                            .social-icons img {
                                width: 24px;
                                height: 24px;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="email-container">
                            <div class="header">
                                <img src="https://res.cloudinary.com/ddorrmob5/image/upload/v1736338301/hoifnqb1bwmdhmunidug.png" alt="Company Logo">
                            </div>
                            <div class="content">
                                <h1>⚠️ Subscription Failed!</h1>
                                <p>Sorry,</p>
                                <p>Your subscription could not be processed. Please try again or contact our support team!</p> 
                            </div>
                            <div class="social-icons">
                                <a href="https://www.facebook.com/"><img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook"></a>
                                <a href="https://twitter.com/"><img src="https://cdn-icons-png.flaticon.com/512/733/733579.png" alt="Twitter"></a>
                                <a href="https://instagram.com/"><img src="https://cdn-icons-png.flaticon.com/512/733/733558.png" alt="Instagram"></a>
                            </div>
                            <div class="footer">
                                <p>&copy; ${new Date().getFullYear()} Nummy. All rights reserved.</p>
                                <p><a href="https://yourwebsite.com/privacy-policy">Privacy Policy</a> | <a href="https://yourwebsite.com/terms">Terms of Service</a></p>
                            </div>
                        </div>
                    </body>
                    </html>
                `,
    });

    res.status(500).json({
      success: false,
      message: "Error creating checkout session",
      error: error.message,
    });
  }
};

// Verify Payment Status
exports.verifyPayment = async (req, res) => {
  const { sessionId } = req.body;

  try {
    // Fetch the session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Check payment status
    const paymentStatus = session;
    let subscriptionStatus = "No subscription";

    // Check if session has a subscription and retrieve the subscription details
    if (session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription
      );
      subscriptionStatus = subscription;
    }

    res.json({
      success: true,
      message: "Payment verification successful",
      data: {
        payment_status: paymentStatus,
        subscription_status: subscriptionStatus,
      },
    });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({
      success: false,
      message: "Error verifying payment",
      error: error.message,
    });
  }
};

// Cancel Subscription
exports.cancelSubscription = async (req, res) => {
  try {
    const { email, subscriptionId } = req.body;

    // Cancel the subscription at the end of the current period
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true, // This ensures the subscription ends at the end of the current period
    });

    const subscriptionEndDate = new Date(
      subscription.current_period_end * 1000
    ).toLocaleDateString();

    // await transporter.sendMail({
    //   from: process.env.EMAIL_USERNAME,
    //   to: email,
    //   subject: "📅 Your Subscription Has Been Cancelled",
    //   html: `
    //         <!DOCTYPE html>
    //         <html>
    //         <head>
    //             <meta charset="UTF-8">
    //             <meta name="viewport" content="width=device-width, initial-scale=1.0">
    //             <title>Subscription Cancellation</title>
    //             <style>
    //                 body {
    //                     font-family: Arial, sans-serif;
    //                     margin: 0;
    //                     padding: 0;
    //                     background-color: #f9f9f9;
    //                 }
    //                 .email-container {
    //                     background-color: #ffffff;
    //                     margin: 20px auto;
    //                     padding: 20px;
    //                     border-radius: 8px;
    //                     box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    //                     max-width: 600px;
    //                 }
    //                 .header {
    //                     text-align: center;
    //                 }
    //                 .header img {
    //                     width: 120px;
    //                 }
    //                 .content {
    //                     margin: 20px 0;
    //                     text-align: center;
    //                 }
    //                 .content h1 {
    //                     color: #d9534f;
    //                 }
    //                 .content p {
    //                     color: #666666;
    //                     font-size: 16px;
    //                     margin: 10px 0;
    //                 }
    //                 .cta-button {
    //                     display: inline-block;
    //                     background-color: #007bff;
    //                     color: white;
    //                     text-decoration: none;
    //                     padding: 12px 24px;
    //                     margin: 20px 0;
    //                     border-radius: 5px;
    //                     font-weight: bold;
    //                 }
    //                 .footer {
    //                     text-align: center;
    //                     margin-top: 30px;
    //                     font-size: 12px;
    //                     color: #999999;
    //                 }
    //                 .social-icons {
    //                     margin: 20px 0;
    //                     text-align: center;
    //                 }
    //                 .social-icons a {
    //                     margin: 0 10px;
    //                     display: inline-block;
    //                 }
    //                 .social-icons img {
    //                     width: 24px;
    //                     height: 24px;
    //                 }
    //             </style>
    //         </head>
    //         <body>
    //             <div class="email-container">
    //                 <div class="header">
    //                     <img src="https://res.cloudinary.com/ddorrmob5/image/upload/v1736338301/hoifnqb1bwmdhmunidug.png" alt="Company Logo">
    //                 </div>
    //                 <div class="content">
    //                     <h1>📅 Subscription Cancelled</h1>
    //                     <p>Hello,</p>
    //                     <p>Your subscription has been successfully cancelled. However, you'll still have access to all premium features until:</p>
    //                     <p><strong>${subscriptionEndDate}</strong></p>
    //                 </div>
    //                 <div class="social-icons">
    //                     <a href="https://facebook.com/yourpage"><img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook"></a>
    //                     <a href="https://twitter.com/yourpage"><img src="https://cdn-icons-png.flaticon.com/512/733/733579.png" alt="Twitter"></a>
    //                     <a href="https://instagram.com/yourpage"><img src="https://cdn-icons-png.flaticon.com/512/733/733558.png" alt="Instagram"></a>
    //                 </div>
    //                 <div class="footer">
    //                     <p>&copy; ${new Date().getFullYear()} Your Company. All rights reserved.</p>
    //                     <p><a href="https://yourwebsite.com/privacy-policy">Privacy Policy</a> | <a href="https://yourwebsite.com/terms">Terms of Service</a></p>
    //                 </div>
    //             </div>
    //         </body>
    //         </html>
    //     `,
    // });

    res.json({
      success: true,
      message: "Subscription cancelled successfully",
      data: subscription,
    });
  } catch (error) {
    console.error("Error cancelling subscription:", error);
    res.status(500).json({
      success: false,
      message: "Error cancelling subscription",
      error: error.message,
    });
  }
};

// List Subscriptions
exports.listSubscriptions = async (req, res) => {
  try {
    const { customerId } = req.query;

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
    });

    res.json({
      success: true,
      message: "Subscriptions retrieved successfully",
      data: { subscriptions },
    });
  } catch (error) {
    console.error("Error listing subscriptions:", error);
    res.status(500).json({
      success: false,
      message: "Error listing subscriptions",
      error: error.message,
    });
  }
};
