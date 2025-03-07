import * as functions from "firebase-functions"

export const transcription = functions.https.onRequest((req, res) => {
  console.log(req)
})
