'use strict';

/**
 * Support: FAQ-first screen, then ticket creation. Admin: list/reply/close.
 */

const FAQ = [
  {
    q: 'ربات بعد از ساخت جواب نمی‌دهد',
    a: '۱) از پنل «ربات‌های من» گزینه «بررسی سلامت» را اجرا کنید.\n۲) اگر توکن از BotFather عوض شده، از «تغییر توکن» استفاده کنید.\n۳) مطمئن شوید وب‌هوک با «ثبت مجدد وب‌هوک» تنظیم شده است.'
  },
  {
    q: 'شارژ کیف پول و تمدید چطور انجام می‌شود؟',
    a: 'از منوی «💰 کیف پول» مبلغ دلخواه را درخواست دهید؛ پس از تأیید پرداخت توسط ادمین، موجودی شارژ می‌شود. تمدید ربات هم از پنل همان ربات انجام می‌شود.'
  },
  {
    q: 'خطای وب‌هوک / خطای 409 conflict',
    a: 'ربات‌ها فقط از یک نقطه (وب‌هوک) فعال می‌مانند. اگر توکن را جای دیگری استفاده کرده‌اید آن را ببندید و از پنل، «ثبت مجدد وب‌هوک» را بزنید.'
  },
  {
    q: 'توکن ربات را عوض کردم، چه کار کنم؟',
    a: 'از پنل ربات گزینه «تغییر توکن» را انتخاب و توکن جدید BotFather را ارسال کنید. اعتبارسنجی و ثبت وب‌هوک خودکار انجام می‌شود.'
  }
];

function faqText() {
  return FAQ.map((f, i) => `❓ <b>${i + 1}. ${f.q}</b>\n${f.a}`).join('\n\n');
}

function createTicket(db, userId, subject, message, botId) {
  const ticket = db.createTicket(userId, subject, botId);
  db.addTicketMessage(ticket.id, 'user', message);
  return db.getTicket(ticket.id);
}

module.exports = { FAQ, faqText, createTicket };
