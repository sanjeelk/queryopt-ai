-- Explicitly scope all table access to the trusted server-side service role.
CREATE POLICY queryopt_service_role_only ON public.app_meta
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY queryopt_service_role_only ON public.customers
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY queryopt_service_role_only ON public.products
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY queryopt_service_role_only ON public.orders
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY queryopt_service_role_only ON public.order_items
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY queryopt_service_role_only ON public.query_measurements
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY queryopt_service_role_only ON public.dataset_imports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

