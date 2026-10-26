\set ON_ERROR_STOP on
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['settings','products','orders','order_items','table_accounts','cash_sessions','pix_payments'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'Tabela obrigatória ausente: %',t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM order_items i LEFT JOIN orders o ON o.id=i.order_id WHERE o.id IS NULL) THEN
    RAISE EXCEPTION 'Existem itens sem pedido';
  END IF;
  IF EXISTS (SELECT 1 FROM orders o LEFT JOIN table_accounts a ON a.id=o.account_id WHERE o.account_id IS NOT NULL AND a.id IS NULL) THEN
    RAISE EXCEPTION 'Existem pedidos sem comanda';
  END IF;
  IF EXISTS (SELECT 1 FROM pix_payments p LEFT JOIN table_accounts a ON a.id=p.account_id WHERE a.id IS NULL) THEN
    RAISE EXCEPTION 'Existem pagamentos sem comanda';
  END IF;
  IF EXISTS (SELECT 1 FROM orders o WHERE o.status<>'Cancelado' AND abs(o.total-(SELECT coalesce(sum(i.quantity*i.unit_price),0) FROM order_items i WHERE i.order_id=o.id))>0.01) THEN
    RAISE EXCEPTION 'Total de pedido divergente de seus itens';
  END IF;
END $$;
SELECT 'Restauração isolada e integridade estrutural/financeira verificadas' AS resultado;
