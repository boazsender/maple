import * as functions from "firebase-functions"
import * as admin from "firebase-admin"
import * as handlebars from "handlebars"
import * as fs from "fs"
import { Timestamp } from "../firebase"
import { getNextDigestAt, getNotificationStartDate } from "./helpers"
import { startOfDay } from "date-fns"
import { TestimonySubmissionNotificationFields, Profile } from "./types"
import {
  BillDigest,
  NotificationEmailDigest,
  Position,
  UserDigest
} from "../email/types"
import { prepareHandlebars } from "../email/handlebarsHelpers"
import { getAuth } from "firebase-admin/auth"
import { Frequency } from "../auth/types"

const NUM_BILLS_TO_DISPLAY = 4
const NUM_USERS_TO_DISPLAY = 4
const NUM_TESTIMONIES_TO_DISPLAY = 6
const EMAIL_TEMPLATE_PATH = "../email/digestEmail.handlebars"

// Get a reference to the Firestore database
const db = admin.firestore()
const auth = getAuth()
const path = require("path")

const getVerifiedUserEmail = async (uid: string) => {
  const userRecord = await auth.getUser(uid)
  if (userRecord && userRecord.email && userRecord.emailVerified) {
    return userRecord.email
  } else {
    return null
  }
}

// TODO: Batching (at both user + email level)?
//       Going to wait until we have a better idea of the performance impact
const deliverEmailNotifications = async () => {
  const now = Timestamp.fromDate(startOfDay(new Date()))

  console.log("Preparing handlebars helpers and partials")
  prepareHandlebars()
  console.log("Handlebars helpers and partials prepared")

  const profilesSnapshot = await db
    .collection("profiles")
    .where("nextDigestAt", "<=", now)
    .get()

  const emailPromises = profilesSnapshot.docs.map(async profileDoc => {
    const profile = profileDoc.data() as Profile
    if (!profile || !profile.notificationFrequency) {
      console.log(
        `User ${profileDoc.id} has no notificationFrequency - skipping`
      )
      return
    }

    const verifiedEmail = await getVerifiedUserEmail(profileDoc.id)
    if (!verifiedEmail) {
      console.log(
        `Skipping user ${profileDoc.id} because they have no verified email address`
      )
      return
    }

    const digestData = await buildDigestData(
      profileDoc.id,
      now,
      profile.notificationFrequency
    )

    // If there are no new notifications, don't send an email
    if (
      digestData.numBillsWithNewTestimony === 0 &&
      digestData.numUsersWithNewTestimony === 0
    ) {
      console.log(
        `No new notifications for ${profileDoc.id} - not sending email`
      )
    } else {
      const htmlString = renderToHtmlString(digestData)

      // Create an email document in /emails to queue up the send
      await db.collection("emails").add({
        to: [verifiedEmail],
        message: {
          subject: "Your Notifications Digest",
          text: "", // blank because we're sending HTML
          html: htmlString
        },
        createdAt: Timestamp.now()
      })

      console.log(`Saved email message to user ${profileDoc.id}`)
    }

    const nextDigestAt = getNextDigestAt(profile.notificationFrequency)
    await profileDoc.ref.update({ nextDigestAt })

    console.log(`Updated nextDigestAt for ${profileDoc.id} to ${nextDigestAt}`)
  })

  // Wait for all email documents to be created
  await Promise.all(emailPromises)
}

// TODO: Unit tests
const buildDigestData = async (
  userId: string,
  now: Timestamp,
  notificationFrequency: Frequency
) => {
  const startDate = getNotificationStartDate(notificationFrequency, now)

  const notificationsSnapshot = await db
    .collection(`users/${userId}/userNotificationFeed`)
    .where("notification.type", "==", "testimony") // Email digest only cares about testimony
    .where("notification.timestamp", ">=", startDate)
    .where("notification.timestamp", "<", now)
    .get()

  const billsById: { [billId: string]: BillDigest } = {}
  const usersById: { [userId: string]: UserDigest } = {}

  notificationsSnapshot.docs.forEach(notificationDoc => {
    const { notification } =
      notificationDoc.data() as TestimonySubmissionNotificationFields

    if (notification.isBillMatch) {
      if (billsById[notification.billId]) {
        const bill = billsById[notification.billId]

        switch (notification.position) {
          case "endorse":
            bill.endorseCount++
            break
          case "neutral":
            bill.neutralCount++
            break
          case "oppose":
            bill.opposeCount++
            break
          default:
            console.error(`Unknown position: ${notification.position}`)
            break
        }
      } else {
        billsById[notification.billId] = {
          billId: notification.billId,
          billName: notification.header,
          billCourt: notification.court,
          endorseCount: notification.position === "endorse" ? 1 : 0,
          neutralCount: notification.position === "neutral" ? 1 : 0,
          opposeCount: notification.position === "oppose" ? 1 : 0
        }
      }
    }

    if (notification.isUserMatch) {
      const billResult = {
        billId: notification.billId,
        court: notification.court,
        position: notification.position as Position
      }
      if (usersById[notification.authorUid]) {
        const user = usersById[notification.authorUid]
        user.bills.push(billResult)
        user.newTestimonyCount++
      } else {
        usersById[notification.authorUid] = {
          userId: notification.authorUid,
          userName: notification.subheader,
          bills: [billResult],
          newTestimonyCount: 1
        }
      }
    }
  })

  const bills = Object.values(billsById).sort((a, b) => {
    return (
      b.endorseCount +
      b.neutralCount +
      b.opposeCount -
      (a.endorseCount + a.neutralCount + a.opposeCount)
    )
  })

  const users = Object.values(usersById)
    .map(userDigest => {
      return {
        ...userDigest,
        bills: userDigest.bills.slice(0, NUM_TESTIMONIES_TO_DISPLAY)
      }
    })
    .sort((a, b) => b.newTestimonyCount - a.newTestimonyCount)

  const digestData = {
    notificationFrequency,
    startDate: startDate.toDate(),
    endDate: now.toDate(),
    bills: bills.slice(0, NUM_BILLS_TO_DISPLAY),
    numBillsWithNewTestimony: bills.length,
    users: users.slice(0, NUM_USERS_TO_DISPLAY),
    numUsersWithNewTestimony: users.length
  }

  return digestData
}

const renderToHtmlString = (digestData: NotificationEmailDigest) => {
  const templateSource = fs.readFileSync(
    path.join(__dirname, EMAIL_TEMPLATE_PATH),
    "utf8"
  )
  const compiledTemplate = handlebars.compile(templateSource)
  return compiledTemplate({ digestData })
}

// Firebase Functions
export const deliverNotifications = functions.pubsub
  .schedule("47 9 1 * 2") // 9:47 AM on the first day of the month and on Tuesdays
  .onRun(deliverEmailNotifications)

export const httpsDeliverNotifications = functions.https.onRequest(
  async (request, response) => {
    try {
      await deliverEmailNotifications()

      console.log("DEBUG: deliverNotifications completed")

      response.status(200).send("Successfully delivered notifications")
    } catch (error) {
      console.error("Error in deliverNotifications:", error)
      response.status(500).send("Internal server error")
    }
  }
)
