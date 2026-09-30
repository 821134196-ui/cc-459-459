"""押金扣款：仅经理可确认、以归还记录为依据、同一订单幂等。"""
from datetime import timedelta

from app.errors import DomainError, Forbidden
from tests.support import T0, ClubTestCase

BALL_PRICE = 800  # 分/颗


class TestDepositReview(ClubTestCase):
    def _returned_short(self, short: int):
        r = self.book(start=T0 - timedelta(minutes=40),
                      end=T0 + timedelta(minutes=20), allow_past=True)
        self.checkin(r, battery=1, basket=1, balls=60)
        self.svc.return_equipment(r["id"], balls_returned=60 - short,
                                  inspector="前台")
        return r

    def test_clerk_can_only_preview_not_confirm(self):
        r = self._returned_short(6)
        preview = self.svc.review_deposit(
            r["id"], role="clerk", manager="前台", confirm=False)
        self.assertTrue(preview["preview"])
        self.assertEqual(preview["balls_fee"], 6 * BALL_PRICE)
        with self.assertRaises(Forbidden):
            self.svc.review_deposit(
                r["id"], role="clerk", manager="前台", confirm=True)
        # 被拒绝后没有产生任何复核/支付
        self.assertEqual(self.svc.deposit_reviews(), [])

    def test_manager_confirm_deducts_and_refunds_once(self):
        r = self._returned_short(6)
        out = self.svc.review_deposit(
            r["id"], role="manager", manager="赵经理", confirm=True)
        self.assertFalse(out.get("idempotent"))
        self.assertEqual(out["balls_fee"], 6 * BALL_PRICE)
        self.assertEqual(out["total_deducted"], 6 * BALL_PRICE)
        self.assertEqual(out["refunded"], 20000 - 6 * BALL_PRICE)
        self.assertTrue(out["payment_txn"].startswith("REF-"))

    def test_review_is_idempotent_repeat_returns_same_txn(self):
        r = self._returned_short(6)
        first = self.svc.review_deposit(
            r["id"], role="manager", manager="赵经理", confirm=True)
        txn = first["payment_txn"]
        # 再次确认（无论参数如何）→ 返回原记录，支付网关收到的是幂等重放
        again = self.svc.review_deposit(
            r["id"], role="manager", manager="赵经理",
            balls_fee=99999, confirm=True)
        self.assertTrue(again["idempotent"])
        self.assertEqual(again["payment_txn"], txn)
        self.assertEqual(again["total_deducted"], first["total_deducted"])
        # 数据库只有一条
        rows = self.conn.execute(
            "SELECT COUNT(*) AS n FROM deposit_reviews WHERE reservation_id=?",
            (r["id"],)).fetchone()
        self.assertEqual(rows["n"], 1)

    def test_no_review_without_return_record(self):
        r = self.book()
        with self.assertRaises(DomainError):
            self.svc.review_deposit(r["id"], role="manager",
                                   manager="赵经理", confirm=True)

    def test_deduction_cannot_exceed_deposit(self):
        r = self._returned_short(6)
        with self.assertRaises(DomainError):
            self.svc.review_deposit(
                r["id"], role="manager", manager="赵经理",
                other_fee=20001, confirm=True)

    def test_scratch_fee_from_return_record(self):
        r = self.book(start=T0 - timedelta(minutes=40),
                      end=T0 + timedelta(minutes=20), allow_past=True)
        self.checkin(r)
        self.svc.return_equipment(r["id"], balls_returned=60, scratch_fen=5000)
        out = self.svc.review_deposit(
            r["id"], role="manager", manager="赵经理", confirm=True)
        self.assertEqual(out["scratch_fee"], 5000)
        self.assertEqual(out["total_deducted"], 5000)

    def test_full_deposit_forfeited_zero_refund_uses_capture(self):
        r = self.book(start=T0 - timedelta(minutes=40),
                      end=T0 + timedelta(minutes=20), allow_past=True)
        self.checkin(r)
        self.svc.return_equipment(r["id"], balls_returned=60)
        # 手工以其他费用扣满押金
        out = self.svc.review_deposit(
            r["id"], role="manager", manager="赵经理",
            balls_fee=0, other_fee=20000, confirm=True)
        self.assertEqual(out["refunded"], 0)
        self.assertTrue(out["payment_txn"].startswith("CAP-"))
