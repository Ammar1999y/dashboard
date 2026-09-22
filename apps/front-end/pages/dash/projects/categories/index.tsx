import { CategoriesPage } from '@/components/categories/page';

export default function Categories() {
  return <CategoriesPage />;
}

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/categories',
      title: {
        template: 'تصنيفات المشاريع',
      },
    },
  };
}
