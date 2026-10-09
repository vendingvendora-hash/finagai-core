/**
 * REAL evidence (ADR-080 regression fixtures), captured 2026-10-09 from perez.julian@correounivalle.edu.co:
 * Gmail message ids, internalDates, subjects, senders and snippets exactly as the Gmail API returns them
 * (snippets HTML-escaped). These are the records whose interpretation flipped between bootstrap proposals #1–#3.
 */
import type { GmailRecord } from "../../src/google/client.js";

export const ACCOUNT = "perez.julian@correounivalle.edu.co";
const LI = "LinkedIn <jobs-noreply@linkedin.com>";
const r = (id: string, internalDate: string, subject: string, from: string, snippet: string, body = "", templates: string[] = []): GmailRecord => ({ id, threadId: id, internalDate: Number(internalDate), subject, from, snippet, body, templates });
const LI_FOOT = "This email was intended for Julian David Perez Cardozo (Financial Analyst | CFA Level I | FMVA (Oct 2026) | Budget Execution & Financial Modeling)\nLearn why we included this:\nYou are receiving LinkedIn notification emails.\nUnsubscribe:\nHelp:\n© 2026 LinkedIn Corporation, 1zwnj000 West Maude Avenue, Sunnyvale, CA 94085.";
/** LinkedIn's REJECTION email: subject reads like a confirmation; only the body/template says what it is. */
const liRejected = (org: string): [string, string[]] => [`Your update from ${org}\n----------------------------------------\n${LI_FOOT}`, ["jobs_application_rejected_01"]];

export const REC = {
  // Vallum Associates
  vallumSent0824: r("1a03211576428f87", "1787546392000", "Julian David, your application was sent to Vallum Associates", LI, "Your application was sent to Vallum Associates ͏ ͏ ͏ ͏"),
  vallumApp0827: r("1a04184d8e328695", "1787805619000", "Your application to Structured Finance Analyst at Vallum Associates", LI, "Your application to Structured Finance Analyst at Vallum Associates ͏ ͏ ͏", ...liRejected("Vallum Associates")),
  vallumSent1009: r("1a1215935b8e3ec5", "1791560855000", "Julian David, your application was sent to Vallum Associates", LI, "Your application was sent to Vallum Associates ͏ ͏ ͏ ͏"),
  // Altarum
  altarumSent0907: r("1a07d6465638b39a", "1788810125000", "Julian David, your application was sent to Altarum Institute", LI, "Your application was sent to Altarum Institute ͏ ͏ ͏"),
  altarumSurvey0914: r("1a0a03d95a77e73e", "1789394772000", "Demographic Survey", "Altarum <no-reply@hire.lever.co>", "Julian, Thank you for your interest in Altarum. As a federal contractor or subcontractor, we are subject to certain governmental recordkeeping and reporting requirements for the administration of civil"),
  altarumScreen0914: r("1a0a03eaa06ea893", "1789394849000", "Phone Screen with Altarum / Julian David Perez Cardozo - Pricing Analyst", "Beth Young <Beth.Young@altarum.org>", "Hi Julian, You&#39;re confirmed for a phone screen at 11:30am EST on Monday, 9/14. I will give you a call at that time. I&#39;m looking forward to speaking with you! Thank you, Beth Young Altarum"),
  altarumInt0914: r("1a0a1594acceeab0", "1789413369000", "Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst", "Beth Young <Beth.Young@altarum.org>", "Hi Julian, You&#39;re confirmed for an interview with Ray Sasselli, Senior FPA Manager, at 1:30pm EST on Friday, 9/18."),
  altarumCanceled0918: r("1a0b49e4be9f7e54", "1789736653000", "Canceled: Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst", "Beth Young <Beth.Young@altarum.org>", "Hi Julian, You&#39;re confirmed for an interview with Ray Sasselli, Senior FPA Manager, at 1:30pm EST on Friday, 9/18."),
  altarumInt0918: r("1a0b51f1b2bcc268", "1789745089000", "Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst", "Beth Young <Beth.Young@altarum.org>", "Hi Julian, You&#39;re confirmed for a virtual interview with Ray Sasselli (Sr. FP&amp;A Manager) at 11:00am EST on Monday, 9/21."),
  altarumInt0924: r("1a0d395c0874b40b", "1790256188000", "Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst", "Beth Young <Beth.Young@altarum.org>", "Hi Julian, You&#39;re confirmed for a virtual interview at 3:00pm EST on Monday, 9/28. You&#39;ll be meeting with: • Frank McKenna (Senior Contracts Specialist) • Carley Kirk (Senior Director, Strategy"),
  altarumOtter0928: r("1a0e97a8f081f9e0", "1790623518000", "Meeting Summary for Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst", "\"JULIAN DAVID PEREZ CARDOZO via Otter.ai\" <no-reply@otter.ai>", "JULIAN DAVID PEREZ CARDOZO has shared notes from Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst, Sep 28 ."),
  altarumFollowup1005: r("1a10d01e4db90856", "1791219589000", "Re: Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst", `JULIAN DAVID PEREZ CARDOZO <${ACCOUNT}>`, "Hi Beth, I hope you&#39;re doing well. I wanted to check in on the Pricing Analyst role after my interview with Frank and Carley last Monday."),
  // Transurban
  transSent1002: r("1a0fa482078ecbcb", "1790905426000", "Julian David, your application was sent to Transurban", LI, "Your application was sent to Transurban ͏ ͏ ͏"),
  transViewed1002: r("1a0fcd31d9610ef9", "1790948088000", "Your application was viewed by Transurban", LI, "Your application was viewed by Transurban ͏ ͏ ͏", `----------------------------------------\n${LI_FOOT}`, ["jobs_job_application_viewed_01"]),
  transSenior1002: r("1a0fcfae55d6732e", "1790950695000", "Your application to Senior Financial Planning Analyst at Transurban", LI, "Your application to Senior Financial Planning Analyst at Transurban ͏ ͏ ͏", ...liRejected("Transurban")),
  transTrends1006: r("1a11203e948bf807", "1791303607000", "See hiring trends for Transurban", "LinkedIn <messages-noreply@linkedin.com>", "Leverage insights to target the right opportunities ͏ ͏"),
  transApplyNow0918: r("1a0b5a583fe2784b", "1789753917000", "Julian David, apply now to ‘Senior Analyst, Financial Planning & Analysis at Transurban’", LI, "Apply to your saved jobs. ͏ ͏ ͏"),
  // Immuta
  immutaSent1005: r("1a10d239a91c2453", "1791221799000", "Julian David, your application was sent to Immuta", LI, "Your application was sent to Immuta ͏ ͏ ͏",
    "Your application was sent to Immuta\nFP&A Analyst\nImmuta\nCollege Park, MD\nView job:\n---------------------------------------------------------\nApplied on October 5, 2026----------------------------------------------------------------\nNow, take these next steps for more success\nView similar jobs you may be interested in\nAnalyst, Finance\nMcKesson\nRichmond, VA\nView job:\n---------------------------------------------------------\nFP&A Analyst\nHyper\nRichmond, VA", ["application_confirmation_with_nba_01"]),
  immutaReject1006: r("1a11212c71b7bd81", "1791304582000", "Application Follow Up - FP&A Analyst @ Immuta", "Immuta <no-reply@hire.lever.co>", "Hi Julian, Thank you for your interest in the FP&amp;A Analyst position at Immuta. Thanks so much for sending your resume our way. After reviewing your work and experience, we&#39;ve made the decision"),
  // Resource Innovations (all 10/09)
  riSent1009: r("1a12146510766e6d", "1791559617000", "Julian David, your application was sent to Resource Innovations", LI, "Your application was sent to Resource Innovations ͏ ͏ ͏"),
  riThanks1009: r("1a121473261d9c72", "1791559675000", "Thanks for applying to Resource Innovations", "Resource Innovations <noreply@candidates.workablemail.com>", "Resource Innovations Your application for the Pricing Analyst job was submitted successfully. Here&#39;s a copy of your application data for safekeeping. Personal information Name Julian David Perez"),
  riPricing1009: r("1a1214bf4543a90f", "1791559986000", "Pricing Analyst - Resource Innovations", "Resource Innovations <noreply@candidates.workablemail.com>", "Hi Julian David - Thank you for your applying to the Pricing Analyst position. We&#39;re currently in the process of reviewing applications for this position. A member of our Talent Acquisition team"),
  // Chimes
  chimesViewed0928: r("1a0e7f1ce5850ed1", "1790597778000", "Your application was viewed by Chimes", LI, "Your application was viewed by Chimes ͏ ͏ ͏"),
  // More real outcomes from the same mailbox (rejections visible only in the BODY, multi-requisition employers)
  cventRejected0820: r("1a020b624309f31d", "1787255201000", "Thank You For Applying to Cvent", "Cvent <cvent+email+5yje-b544b3164d@talent.icims.com>", "Hi Julian, Thank you for taking the time to apply to the Senior Financial Analyst, Strategic Finance (AI Portfolio) position at Cvent. We know you have many options when looking for employment",
    "Hi Julian,\nThank you for taking the time to apply to the Senior Financial Analyst, Strategic Finance (AI Portfolio) position at Cvent. We know you have many options when looking for employment opportunities and we greatly appreciate the time you've invested in Cvent. After reviewing your qualifications and questionnaire responses, we regret to inform you that we will not be proceeding at this time. We receive 150,000+ applications annually, and we have a limited number of available positions."),
  windowNationRejected0821: r("1a02477ab163f661", "1787318214000", "Thanks for your interest in Window Nation, Julian", "Window Nation <no-reply@hire.lever.co>", "Hi Julian, Thank you for taking the time to apply for the Senior Strategy Analyst role at Window Nation. We&#39;ve received a high volume of interest in this opportunity, and while we do our best to",
    "Hi Julian,\nThank you for taking the time to apply for the Senior Strategy Analyst role at Window Nation. We’ve received a high volume of interest in this opportunity, and while we do our best to review every application carefully, the process can sometimes take longer than we’d like. After completing our initial review, we’ve decided not to move forward with your application at this time."),
  accentureRejected0903: r("1a0662a2c400df2a", "1788420434000", "Update on Your Accenture Application", "Accenture <accenture@myworkday.com>", "Hi Julian, Thank you for your interest in Accenture and giving us the opportunity to learn about your background and qualifications. We have carefully considered your application against our hiring",
    "| Hi Julian, Thank you for your interest in Accenture and giving us the opportunity to learn about your background and qualifications. We have carefully considered your application against our hiring needs and are unable to move forward at this time. Reference Role: R00336590 Pricing & Deal Structuring Specialist Accenture Recruitment Team |"),
  jhuRejected0911: r("1a0916a62b60b763", "1789146062000", "Update: JHU Application", "JHU <system@successfactors.com>", "Greetings: Thank you for your interest in Johns Hopkins University (JHU). We appreciate the time and effort you put into submitting an application for req #120088 Financial Analyst (DOM General",
    "Greetings:\nThank you for your interest in Johns Hopkins University (JHU). We appreciate the time and effort you put into submitting an application for req #120088 Financial Analyst (DOM General Internal Medicine).\nThe hiring process at JHU is highly competitive, and we regret to inform you that we are not moving forward with your application at this time."),
  amazonRejected0920: r("1a0bfdbe829c9653", "1789925254000", "Amazon application: Status update", "Amazon.jobs <noreply@mail.amazon.jobs>", "Amazon.jobs Hi Julian, Thank you for your application for the position of Sr. Financial Analyst, Amazon Business Finance (ID: 10460629). Unfortunately at this time, we are unable to move forward with"),
  amazonApplied1005: r("1a10a40993b2093a", "1791173367000", "Thank you for Applying to Amazon!", "Amazon.jobs <noreply@mail.amazon.jobs>", "Amazon.jobs Hi Julian, Thanks for applying to Amazon! We&#39;ve received your application for the Senior Financial Analyst, R2L Sub Same Day - Delivery Finance (ID: 10471926) position. What happens"),
  yahooApplied0922: r("1a0caaf9743e389a", "1790106899000", "Thanks for applying to Yahoo!", "Yahoo <ouryahoo@myworkday.com>", "Julian , Thank you for your interest in the Price and Yield Manager position. Good news, your resume has made its way into the hands of one of our talented recruiters. We are reviewing candidates and"),
  yahooRejected1007: r("1a11541040f7575f", "1791357944000", "Thank you for exploring careers at Yahoo!", "Yahoo <ouryahoo@myworkday.com>", "Julian , Thank you for your interest in the Price and Yield Manager role at Yahoo. At this time, the hiring team has decided to move forward with other candidates who are more closely aligned with the"),
  indeedApplied1005: r("1a10e13bce4d953c", "1791237536000", "Indeed Application: Senior Finance Analyst - Commercial Performance & Investment Review", "Indeed Apply <indeedapply@indeed.com>", "We&#39;ll help you get started"),
  glassdoorCommunity1007: r("1a1173e6274e4f0a", "1791391325000", "I've been applying to a ton of jobs lately. Why isn't anyone getting back to me?", "Glassdoor Community <noreply@glassdoor.com>", "Hear the hottest real talk across the Glassdoor community"),
  newsletter1009: r("1a121375ce73b3d6", "1791558638000", "New US Jobs Update - 09th Oct 2026", "LinkedIn News <newsletters-noreply@linkedin.com>", "Edition: 09th Oct 2026 Don&#39;t Have Time to Job Hunt? We&#39;ll Do It For You. We&#39;ll…"),
  // Noise that must not create organizations
  otterWeekly1005: r("1a10b142f24391dc", "1791187233000", "Your upcoming meetings", "Otter.ai <no-reply@otter.ai>", "Otter.ai – Get ready for your week Otter.ai logo View all conversations → Get ready for your week Here&#39;s your recent activity and upcoming meeting. My conversations View all Interview with Altarum"),
};

const H = "Job ID,Date First Analyzed,Date Last Updated,Company,Title,Location,Work Mode,Employment Type,Posting URL,Eligibility Status,Eligibility Detail,Application Status,Overall Match Score,Fit Concerns Summary,Salary Range,Priority,Next Action,Next Action Date,Latest Resume Link,Latest Cover Letter Link,Job Folder Link";
export const SHEET_CSV = [H,
  "mtdy30,,,Altarum,Pricing Analyst,\"Silver Spring, MD\",Hybrid,Full-time,https://www.linkedin.com/jobs/view/4462053616,No Restriction Identified,,Analyzed,88,,95000 105000 USD,Medium,,,,,",
  "m18usy,,,\"M.C. Dean, Inc.\",Financial Analyst,\"McLean, VA\",,Full-time,https://www.linkedin.com/jobs/view/4205880810/,No Restriction Identified,,Analyzed,92,,,Medium,,,,,",
  "k53b3a,,,Northrop Grumman,Program Cost Control Analyst,\"Linthicum Heights, MD\",,Full-time,https://www.linkedin.com/jobs/view/4445298534/,Active Security Clearance Required,,Analyzed,90,,,Medium,,,,,",
].join("\n");

/** Which fixed query each record is returned by (mirrors CAREER_QUERIES semantics). */
export function queryHits(key: string, recs: GmailRecord[]): GmailRecord[] {
  const t = (x: GmailRecord) => `${x.subject} ${x.snippet} ${x.body ?? ""}`.toLowerCase();
  if (key === "applications") return recs.filter((x) => /application|applying|applied/.test(x.subject.toLowerCase()) || /thanks for applying|thank you for applying|thank you for your applying|thank you for your interest|your application/.test(t(x)));
  if (key === "interviews") return recs.filter((x) => /interview|phone screen|screening|next steps/.test(x.subject.toLowerCase()));
  if (key === "outcomes") return recs.filter((x) => /regret to inform|not to move forward|not moving forward|unable to move forward|not be proceeding|move forward with other|move forward with another|made the decision|position has been filled|no longer under consideration|not been selected|offer letter|pleased to offer/.test(t(x)));
  return [];
}
